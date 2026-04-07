const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname + '/public'));
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// --- BLACKJACK LOGIC ---
function buildShoe() {
    let shoe = []; const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']; const ss = ['♠','♣','♥','♦'];
    for(let d=0; d<6; d++) {
        for(let s of ss) {
            for(let v of vs) {
                let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
                shoe.push({ val: v, suit: s, bjVal: bj });
            }
        }
    }
    for (let i = shoe.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shoe[i], shoe[j]] = [shoe[j], shoe[i]]; }
    return shoe;
}

function getScore(cards) {
    let score = 0, aces = 0;
    for (let c of cards) { score += c.bjVal; if (c.val === 'A') aces++; }
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
}

let shoe = buildShoe();
function drawCard() { if(shoe.length < 52) shoe = buildShoe(); return shoe.pop(); }

// --- STATE MACHINE ---
let state = {
    status: 'BETTING', // BETTING, DEALING, PLAYER_TURN, DEALER_TURN, RESOLVED
    timer: 15,
    activeTurn: { seat: null, handIdx: 0 },
    dealer: { cards: [], score: 0 },
    seats: {
        1: null, 2: null, 3: null, 4: null, 5: null
    }
};

function broadcastState() {
    let payload = JSON.parse(JSON.stringify(state));
    // Hide dealer's downcard
    if (payload.status !== 'DEALER_TURN' && payload.status !== 'RESOLVED' && payload.dealer.cards.length === 2) {
        payload.dealer.cards[1] = 'hidden';
        payload.dealer.score = payload.dealer.cards[0].bjVal;
    }
    io.emit('stateUpdate', payload);
}

// Send timer independently so cards don't constantly flash/re-render
function broadcastTimer() {
    let hasBets = Object.values(state.seats).some(s => s && s.hands && s.hands.length > 0 && s.hands[0].bet > 0);
    io.emit('timerTick', { status: state.status, timer: state.timer, hasBets: hasBets });
}

function nextTurn() {
    let startSeat = state.activeTurn.seat === null ? 1 : state.activeTurn.seat;
    let startHand = state.activeTurn.seat === null ? 0 : state.activeTurn.handIdx;

    // Check current seat's next hands first
    if (state.activeTurn.seat !== null) {
        let seat = state.seats[startSeat];
        if (seat && startHand + 1 < seat.hands.length) {
            if (seat.hands[startHand + 1].status === 'PLAYING') {
                state.activeTurn.handIdx++;
                state.timer = 15;
                broadcastState();
                return;
            }
        }
    }

    // Move to subsequent seats
    let nextSeatNum = startSeat + (state.activeTurn.seat === null ? 0 : 1);
    for (let i = nextSeatNum; i <= 5; i++) {
        let s = state.seats[i];
        if (s && s.hands) {
            for(let h=0; h<s.hands.length; h++) {
                if (s.hands[h].status === 'PLAYING') {
                    state.activeTurn = { seat: i, handIdx: h };
                    state.timer = 15;
                    broadcastState();
                    return;
                }
            }
        }
    }

    // No more active players. Dealer's Turn.
    state.activeTurn = { seat: null, handIdx: 0 };
    resolveDealer();
}

function resolveDealer() {
    state.status = 'DEALER_TURN';
    state.dealer.score = getScore(state.dealer.cards);
    broadcastState();

    let dealerInterval = setInterval(() => {
        if (state.dealer.score < 17) {
            state.dealer.cards.push(drawCard());
            state.dealer.score = getScore(state.dealer.cards);
            broadcastState();
        } else {
            clearInterval(dealerInterval);
            finishRound();
        }
    }, 1000); // 1-second suspense per dealer draw
}

function finishRound() {
    state.status = 'RESOLVED';
    let dScore = state.dealer.score;
    let dealerNatural = (state.dealer.cards.length === 2 && dScore === 21);
    
    for(let i=1; i<=5; i++) {
        let s = state.seats[i];
        if (s && s.hands) {
            s.hands.forEach(h => {
                let playerNatural = (h.cards.length === 2 && h.score === 21 && !h.isSplit);
                
                if (h.status === 'BUST') { h.result = 'LOSS'; }
                else if (dealerNatural && !playerNatural) { h.result = 'LOSS'; }
                else if (playerNatural && !dealerNatural) { h.result = 'WIN'; } // BJ 1.5x
                else if (dScore > 21 || h.score > dScore) { h.result = 'WIN'; }
                else if (h.score === dScore) { h.result = 'PUSH'; }
                else { h.result = 'LOSS'; }
            });
        }
    }
    
    broadcastState();

    // Reset Table
    setTimeout(() => {
        state.dealer = { cards: [], score: 0 };
        for(let i=1; i<=5; i++) {
            let s = state.seats[i];
            if (s) {
                if (!s.hands || s.hands.length === 0 || s.hands[0].bet === 0) {
                    state.seats[i] = null; // Kick idlers
                } else {
                    s.hands = []; // Clear hands, await new bets
                }
            }
        }
        state.status = 'BETTING';
        state.timer = 15;
        state.activeTurn = { seat: null, handIdx: 0 };
        broadcastState();
    }, 5000);
}

// MAIN ENGINE LOOP
setInterval(() => {
    if (state.status === 'BETTING') {
        let hasBets = Object.values(state.seats).some(s => s && s.hands && s.hands.length > 0 && s.hands[0].bet > 0);
        if (hasBets) {
            state.timer--;
            if (state.timer <= 0) {
                state.status = 'DEALING';
                broadcastState();
                
                let activeSeats = Object.keys(state.seats).filter(k => state.seats[k] !== null && state.seats[k].hands && state.seats[k].hands.length > 0 && state.seats[k].hands[0].bet > 0);
                
                // Initial Deal
                activeSeats.forEach(k => { 
                    let score = getScore(state.seats[k].hands[0].cards);
                    state.seats[k].hands[0].cards = [drawCard(), drawCard()]; 
                    state.seats[k].hands[0].score = getScore(state.seats[k].hands[0].cards); 
                    state.seats[k].hands[0].status = state.seats[k].hands[0].score === 21 ? 'BLACKJACK' : 'PLAYING'; 
                });
                state.dealer.cards = [drawCard(), drawCard()];
                state.dealer.score = getScore(state.dealer.cards);
                
                // Jump to Player turns
                setTimeout(() => { state.status = 'PLAYER_TURN'; nextTurn(); }, 1000);
                return;
            }
        } else {
            state.timer = 15;
        }
        broadcastTimer(); // Emit silent tick
    } 
    else if (state.status === 'PLAYER_TURN') {
        state.timer--;
        if (state.timer <= 0) {
            if (state.activeTurn.seat !== null) {
                state.seats[state.activeTurn.seat].hands[state.activeTurn.handIdx].status = 'STAND';
                nextTurn();
            }
        } else {
            broadcastTimer();
        }
    }
}, 1000);

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        socket.playerName = name;
        broadcastState();
        broadcastTimer();
    });

    socket.on('sendChat', (msg) => {
        if(socket.playerName) io.emit('chatMessage', { name: socket.playerName, msg: msg });
    });

    socket.on('takeSeat', (seatNum) => {
        if (!socket.playerName || state.seats[seatNum] || state.status !== 'BETTING') return;
        for(let i=1; i<=5; i++) { if(state.seats[i] && state.seats[i].name === socket.playerName) return; }
        
        state.seats[seatNum] = { name: socket.playerName, socketId: socket.id, hands: [] };
        broadcastState();
    });

    socket.on('leaveSeat', () => {
        if (state.status !== 'BETTING') return; 
        for(let i=1; i<=5; i++) {
            if(state.seats[i] && state.seats[i].socketId === socket.id) {
                state.seats[i] = null;
                broadcastState();
                break;
            }
        }
    });

    socket.on('placeBet', (amt) => {
        if (state.status !== 'BETTING') return;
        for(let i=1; i<=5; i++) {
            let s = state.seats[i];
            if (s && s.socketId === socket.id) {
                if (s.hands.length === 0) s.hands.push({ bet: 0, cards: [], score: 0, status: 'WAITING', isSplit: false });
                if (s.hands[0].bet === 0) {
                    s.hands[0].bet = amt;
                    state.timer = 15; // Instantly reset timer for others to join
                    broadcastState();
                    break;
                }
            }
        }
    });

    socket.on('playerAction', (action) => {
        if (state.status !== 'PLAYER_TURN' || state.activeTurn.seat === null) return;
        let seat = state.seats[state.activeTurn.seat];
        if (!seat || seat.socketId !== socket.id) return; 
        let hand = seat.hands[state.activeTurn.handIdx];

        if (action === 'hit') {
            hand.cards.push(drawCard());
            hand.score = getScore(hand.cards);
            state.timer = 15;
            if (hand.score >= 21) {
                hand.status = hand.score > 21 ? 'BUST' : 'STAND';
                nextTurn();
            } else {
                broadcastState();
            }
        } 
        else if (action === 'stand') {
            hand.status = 'STAND';
            nextTurn();
        }
        else if (action === 'double') {
            if (hand.cards.length === 2) {
                hand.bet *= 2;
                hand.cards.push(drawCard());
                hand.score = getScore(hand.cards);
                hand.status = hand.score > 21 ? 'BUST' : 'STAND';
                nextTurn();
            }
        }
        else if (action === 'split') {
            if (hand.cards.length === 2 && seat.hands.length === 1 && hand.cards[0].bjVal === hand.cards[1].bjVal) {
                let splitCard = hand.cards.pop();
                
                // Hand 1 (Original)
                hand.cards.push(drawCard());
                hand.score = getScore(hand.cards);
                hand.isSplit = true;
                if (hand.score === 21) hand.status = 'STAND'; // Auto-stand on 21

                // Hand 2 (New)
                let newHand = { bet: hand.bet, cards: [splitCard, drawCard()], score: 0, status: 'PLAYING', isSplit: true };
                newHand.score = getScore(newHand.cards);
                if (newHand.score === 21) newHand.status = 'STAND';
                
                seat.hands.push(newHand);
                state.timer = 15;

                if (hand.status === 'STAND') nextTurn(); // If hand 1 got 21, move to hand 2 immediately
                else broadcastState();
            }
        }
    });

    socket.on('disconnect', () => {
        for(let i=1; i<=5; i++) {
            if(state.seats[i] && state.seats[i].socketId === socket.id) {
                if (state.status === 'BETTING') { state.seats[i] = null; } 
                else { 
                    // Auto-stand all their hands
                    if(state.seats[i].hands) state.seats[i].hands.forEach(h => h.status = 'STAND'); 
                    if (state.activeTurn.seat === i) nextTurn(); 
                }
                broadcastState();
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`♠️ VIP Blackjack Sandbox running on port ${PORT}`));
