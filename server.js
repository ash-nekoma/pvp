require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const formatTC = (amount) => Math.round(amount * 10) / 10;

let mockUsers = {};
let connectedUsers = {};

// =========================================================================
// 6-DECK SHOE LOGIC
// =========================================================================
let shoe = [];
function buildShoe() {
    shoe = [];
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const ss = ['♠','♣','♥','♦'];
    for(let d=0; d<6; d++) {
        for(let s of ss) {
            for(let v of vs) {
                let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
                let colorClass = (s === '♥' || s === '♦') ? `card-red` : `card-black`;
                shoe.push({ val: v, suit: s, bjVal: bj, raw: v, suitHtml: `<span class="${colorClass}">${s}</span>` });
            }
        }
    }
    for (let i = shoe.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
}
buildShoe();

function drawCard() {
    if(shoe.length < 52) buildShoe(); 
    return shoe.pop();
}

function getBJScore(hand) {
    let score = 0, aces = 0;
    for (let card of hand) { score += card.bjVal; if (card.raw === 'A') aces += 1; }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

function isNaturalBlackjack(handCards) { return (handCards.length === 2 && getBJScore(handCards) === 21); }

// =========================================================================
// PREMIUM DERBY LOGIC (Strict 15s Betting)
// =========================================================================
let hrState = { time: 15, status: 'BETTING', bets: [], currentOdds: {} }; // 15s timer

function generateHorseOdds() {
    const horses = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange'];
    const multipliers = [2, 4, 6, 11, 16, 31].sort(() => Math.random() - 0.5);
    let oddsMap = {}; 
    horses.forEach((h, i) => { oddsMap[h] = multipliers[i]; });
    hrState.currentOdds = oddsMap;
}
generateHorseOdds(); 

setInterval(() => {
    if (hrState.status === 'BETTING') {
        hrState.time--;
        io.emit('hrTimerUpdate', { time: hrState.time, odds: hrState.currentOdds });

        if (hrState.time <= 0) {
            hrState.status = 'RACING';
            io.emit('hrLockBets');

            setTimeout(async () => {
                const horses = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange'];
                let weights = horses.map(h => ({ horse: h, weight: 1 / hrState.currentOdds[h] }));
                let totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
                let randomVal = Math.random() * totalWeight;
                let winner = weights[0].horse;
                let cumulative = 0;
                for(let w of weights) { cumulative += w.weight; if(randomVal <= cumulative) { winner = w.horse; break; } }

                io.emit('hrRaceStart', { winner: winner, duration: 15000 }); 

                setTimeout(async () => {
                    hrState.bets.forEach(b => {
                        let user = mockUsers[b.username];
                        if (user && b.choice === winner) {
                            let payout = b.amount * hrState.currentOdds[winner];
                            user.credits += formatTC(payout);
                        }
                    });
                    io.emit('hrRaceResults', { winner: winner, payoutMult: hrState.currentOdds[winner] });
                }, 15500); 

                setTimeout(() => {
                    generateHorseOdds(); 
                    hrState.time = 15; // Reset to 15s
                    hrState.status = 'BETTING';
                    hrState.bets = [];
                    io.emit('hrNewRound', { odds: hrState.currentOdds }); 
                }, 22000);
            }, 500);
        }
    }
}, 1000);

// =========================================================================
// VIP BLACKJACK ENGINE (Intelligent Timer & Multi-Hit Fix)
// =========================================================================
let mbjState = {
    status: 'BETTING', time: 15, turnTimer: 0, 
    activeTurn: { seat: null, handIdx: 0 }, 
    dealer: { hand: [], score: 0 },
    seats: { 1: null, 2: null, 3: null, 4: null, 5: null } 
};

function mbjNextTurn() {
    let seatNum = mbjState.activeTurn.seat;
    let handIdx = mbjState.activeTurn.handIdx;

    if (seatNum !== null) {
        let seat = mbjState.seats[seatNum];
        if (seat && handIdx + 1 < seat.hands.length && seat.hands[handIdx + 1].status === 'PLAYING') {
            mbjState.activeTurn.handIdx++;
            mbjState.turnTimer = 15; 
            io.to('mbj').emit('mbjUpdate', { event: 'turn', activeTurn: mbjState.activeTurn, time: mbjState.turnTimer, seats: mbjState.seats });
            return;
        }
    }

    let nextSeatNum = null;
    let startIdx = seatNum ? parseInt(seatNum) + 1 : 1;
    for (let i = startIdx; i <= 5; i++) {
        let s = mbjState.seats[i];
        if (s && s.hands.some(h => h.status === 'PLAYING')) { nextSeatNum = i; break; }
    }

    if (nextSeatNum !== null) {
        mbjState.activeTurn = { seat: nextSeatNum, handIdx: 0 };
        mbjState.turnTimer = 15;
        io.to('mbj').emit('mbjUpdate', { event: 'turn', activeTurn: mbjState.activeTurn, time: mbjState.turnTimer, seats: mbjState.seats });
    } else {
        mbjResolveDealer();
    }
}

async function mbjResolveDealer() {
    mbjState.status = 'RESOLVING';
    mbjState.activeTurn = { seat: null, handIdx: 0 };
    
    let playersAlive = false;
    for (let i=1; i<=5; i++) {
        if(mbjState.seats[i]) {
            mbjState.seats[i].hands.forEach(h => { if(h.status === 'STAND') playersAlive = true; });
        }
    }

    let dScore = getBJScore(mbjState.dealer.hand);
    if (playersAlive) {
        while (dScore < 17) {
            mbjState.dealer.hand.push(drawCard());
            dScore = getBJScore(mbjState.dealer.hand);
        }
    }
    mbjState.dealer.score = dScore;
    
    let dealerNatural = isNaturalBlackjack(mbjState.dealer.hand);
    let dealerUpcardVal = mbjState.dealer.hand[0].bjVal;

    let seatResults = {}; 
    for (let i=1; i<=5; i++) {
        let seat = mbjState.seats[i];
        if (seat && seat.hands.length > 0) {
            let totalWin = 0; let totalPush = 0; 
            
            seat.hands.forEach(h => {
                if (h.status === 'BUST') return; 
                let pScore = h.score;
                let payout = 0, isPush = false, refundAmount = 0;
                let playerNatural = isNaturalBlackjack(h.cards) && !h.isSplitHand;
                
                if (dealerNatural) {
                    if (playerNatural) isPush = true;
                    else {
                        if (dealerUpcardVal === 10 && h.doubledAmount > 0) refundAmount += h.doubledAmount; 
                        payout = 0; 
                    }
                } else if (playerNatural) {
                    payout = h.bet * 2.5; 
                } else if (dScore > 21 || pScore > dScore) {
                    payout = h.bet * 2;
                } else if (pScore === dScore) {
                    isPush = true;
                }

                if (isPush) totalPush += h.bet; 
                else totalWin += (payout + refundAmount);
            });

            seatResults[i] = { win: totalWin, push: totalPush };
            let user = mockUsers[seat.username];
            if(user) {
                user.credits += formatTC(totalWin + totalPush);
                if(connectedUsers[user.username]) io.to(connectedUsers[user.username]).emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
            }
        }
    }

    io.to('mbj').emit('mbjUpdate', { event: 'dealer_resolved', dealerHand: mbjState.dealer.hand, dealerScore: dScore, seats: mbjState.seats, results: seatResults });
    
    setTimeout(() => {
        for (let i=1; i<=5; i++) {
            if (mbjState.seats[i]) {
                if (mbjState.seats[i].hands.length === 0 || mbjState.seats[i].hands[0].bet === 0) mbjState.seats[i] = null;
                else { mbjState.seats[i].hands = []; }
            }
        }
        mbjState.dealer.hand = []; mbjState.time = 15; mbjState.status = 'BETTING';
        io.to('mbj').emit('mbjUpdate', { event: 'new_round', seats: mbjState.seats });
    }, 12000); 
}

// Timer Loop
setInterval(() => {
    if (mbjState.status === 'BETTING') {
        // Only count down if someone has placed a bet
        let hasBets = Object.values(mbjState.seats).some(s => s && s.hands.length > 0 && s.hands[0].bet > 0);
        
        if (hasBets) {
            mbjState.time--;
            io.to('mbj').emit('mbjUpdate', { event: 'timer', time: mbjState.time, active: true });
        } else {
            mbjState.time = 15; // Hold at 15
            io.to('mbj').emit('mbjUpdate', { event: 'timer', time: mbjState.time, active: false });
        }
        
        if (mbjState.time <= 0 && hasBets) {
            for (let i=1; i<=5; i++) {
                if (mbjState.seats[i] && (mbjState.seats[i].hands.length === 0 || mbjState.seats[i].hands[0].bet === 0)) mbjState.seats[i] = null;
            }

            let activeSeats = Object.keys(mbjState.seats).filter(k => mbjState.seats[k] !== null);
            
            if (activeSeats.length > 0) {
                mbjState.status = 'DEALING';
                io.to('mbj').emit('mbjUpdate', { event: 'lock_bets' });
                
                mbjState.dealer.hand = [drawCard(), drawCard()];
                activeSeats.forEach(k => {
                    let c1 = drawCard(), c2 = drawCard();
                    mbjState.seats[k].hands[0].cards = [c1, c2];
                    mbjState.seats[k].hands[0].isSplitHand = false;
                    mbjState.seats[k].initialTotalBet = mbjState.seats[k].hands[0].bet;
                    let score = getBJScore([c1, c2]);
                    mbjState.seats[k].hands[0].score = score;
                    mbjState.seats[k].hands[0].status = score === 21 ? 'BLACKJACK' : 'PLAYING';
                });

                let hiddenDealer = [mbjState.dealer.hand[0], { raw: '?', suitHtml: `<span class="card-black">?</span>`, bjVal: 0 }];
                
                let totalCardsToDeal = (activeSeats.length * 2) + 2;
                let animTime = (totalCardsToDeal * 400) + 1000; 

                io.to('mbj').emit('mbjUpdate', { event: 'deal', seats: mbjState.seats, dealerHand: hiddenDealer });

                setTimeout(() => {
                    mbjState.activeOrder = activeSeats.filter(k => mbjState.seats[k].hands[0].status === 'PLAYING');
                    if (mbjState.activeOrder.length > 0) {
                        mbjState.status = 'PLAYER_TURN';
                        mbjState.activeTurn = { seat: mbjState.activeOrder[0], handIdx: 0 };
                        mbjState.turnTimer = 15;
                        io.to('mbj').emit('mbjUpdate', { event: 'turn', activeTurn: mbjState.activeTurn, time: mbjState.turnTimer, seats: mbjState.seats });
                    } else {
                        mbjResolveDealer(); 
                    }
                }, animTime); 
            }
        }
    } else if (mbjState.status === 'PLAYER_TURN') {
        mbjState.turnTimer--;
        io.to('mbj').emit('mbjUpdate', { event: 'turn_timer', time: mbjState.turnTimer });
        
        if (mbjState.turnTimer <= 0) {
            let seat = mbjState.seats[mbjState.activeTurn.seat];
            if(seat && seat.hands[mbjState.activeTurn.handIdx]) seat.hands[mbjState.activeTurn.handIdx].status = 'STAND';
            mbjNextTurn();
        }
    }
}, 1000);

io.on('connection', (socket) => {
    socket.emit('hrTimerUpdate', { time: hrState.time, odds: hrState.currentOdds });
    if(mbjState.status === 'BETTING') socket.emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });

    // AUTO-LOGIN LISTENER
    socket.on('login', (data) => {
        let user = mockUsers[data.username];
        if(!user) {
            user = { username: data.username, password: data.password, credits: 10000, playableCredits: 0 };
            mockUsers[data.username] = user;
        }
        socket.user = user; connectedUsers[user.username] = socket.id;
        socket.emit('loginSuccess', { username: user.username, credits: user.credits, playable: user.playableCredits });
    });

    socket.on('joinRoom', (room) => { socket.join(room); });
    socket.on('leaveRoom', (room) => { socket.leave(room); });

    socket.on('placeSharedBet', (data) => {
        if (!socket.user || hrState.status !== 'BETTING') return;
        let amt = formatTC(data.amount);
        let user = mockUsers[socket.user.username];
        if(user && user.credits >= amt) {
            user.credits -= amt;
            hrState.bets.push({ username: user.username, choice: data.choice, amount: amt });
            socket.emit('sharedBetConfirmed', { room: data.room, choice: data.choice, amount: amt });
            socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
        }
    });

    socket.on('mbjTakeSeat', (seatNum) => {
        if (!socket.user || mbjState.seats[seatNum] || mbjState.status !== 'BETTING') return;
        for(let i=1; i<=5; i++) { if (mbjState.seats[i] && mbjState.seats[i].username === socket.user.username) return; }
        mbjState.seats[seatNum] = { username: socket.user.username, hands: [] };
        io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
    });

    socket.on('mbjLeaveSeat', () => {
        if (!socket.user) return;
        for(let i=1; i<=5; i++) {
            let s = mbjState.seats[i];
            if (s && s.username === socket.user.username && mbjState.status === 'BETTING') {
                if (s.hands.length > 0 && s.hands[0].bet > 0) {
                    let user = mockUsers[socket.user.username];
                    if (user) {
                        user.credits += s.hands[0].bet;
                        socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
                    }
                }
                mbjState.seats[i] = null;
                io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
                break;
            }
        }
    });

    socket.on('mbjPlaceBet', (amount) => {
        if (!socket.user || mbjState.status !== 'BETTING') return;
        let seatNum = null;
        for(let i=1; i<=5; i++) { if (mbjState.seats[i] && mbjState.seats[i].username === socket.user.username) seatNum = i; }
        if (!seatNum) return;

        let amt = formatTC(amount);
        let user = mockUsers[socket.user.username];
        if(user && user.credits >= amt) {
            user.credits -= amt;
            let s = mbjState.seats[seatNum];
            if (s.hands.length === 0) s.hands.push({ bet: 0, originalBet: 0, doubledAmount: 0, cards: [], score: 0, status: 'WAITING', isSplitHand: false });
            
            s.hands[0].bet += amt;
            s.hands[0].originalBet += amt;
            
            socket.emit('balanceUpdateData', { credits: user.credits });
            io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
        }
    });

    // BUG FIX: Sends activeTurn correctly after EVERY hit so buttons stay visible
    socket.on('mbjAction', (actionData) => {
        if (!socket.user || mbjState.status !== 'PLAYER_TURN' || mbjState.activeTurn.seat === null) return;
        let seatNum = mbjState.activeTurn.seat;
        let handIdx = mbjState.activeTurn.handIdx;
        let seat = mbjState.seats[seatNum];
        
        if (seat.username !== socket.user.username) return; 
        let hand = seat.hands[handIdx];

        if (actionData.type === 'hit') {
            if (hand.isSplitAce) return; 
            hand.cards.push(drawCard());
            hand.score = getBJScore(hand.cards);
            if (hand.score > 21) { 
                hand.status = 'BUST'; 
                io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn }); 
                mbjNextTurn(); 
            } 
            else { 
                io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn }); 
            }
        } 
        else if (actionData.type === 'stand') {
            hand.status = 'STAND';
            io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn });
            mbjNextTurn();
        }
        else if (actionData.type === 'double') {
            if (hand.cards.length !== 2) return;
            let user = mockUsers[socket.user.username];
            if (user && user.credits >= hand.bet) {
                user.credits -= hand.bet;
                socket.emit('balanceUpdateData', { credits: user.credits });
                
                hand.doubledAmount = hand.bet; 
                hand.bet *= 2;
                
                hand.cards.push(drawCard());
                hand.score = getBJScore(hand.cards);
                hand.status = hand.score > 21 ? 'BUST' : 'STAND';
                io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn });
                mbjNextTurn();
            }
        }
    });

    socket.on('disconnect', () => { delete connectedUsers[socket.user?.username]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Premium Backend running on port ${PORT}`));
