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
    activeSeat: null,
    dealer: { cards: [], score: 0 },
    seats: {
        1: null, 2: null, 3: null, 4: null, 5: null
    }
};

function broadcastState() {
    // Hide dealer's second card if it's not their turn yet
    let payload = JSON.parse(JSON.stringify(state));
    if (payload.status !== 'DEALER_TURN' && payload.status !== 'RESOLVED' && payload.dealer.cards.length === 2) {
        payload.dealer.cards[1] = 'hidden';
        payload.dealer.score = payload.dealer.cards[0].bjVal;
    }
    io.emit('stateUpdate', payload);
}

function nextTurn() {
    let activeKeys = Object.keys(state.seats).filter(k => state.seats[k] !== null && state.seats[k].bet > 0 && state.seats[k].status === 'PLAYING');
    
    // Find who is currently active, and move to the next one
    if (state.activeSeat === null && activeKeys.length > 0) {
        state.activeSeat = parseInt(activeKeys[0]);
    } else {
        let currentIndex = activeKeys.indexOf(state.activeSeat.toString());
        if (currentIndex !== -1 && currentIndex + 1 < activeKeys.length) {
            state.activeSeat = parseInt(activeKeys[currentIndex + 1]);
        } else {
            // No more players. Dealer turn.
            state.activeSeat = null;
            resolveDealer();
            return;
        }
    }
    
    state.timer = 15;
    broadcastState();
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
    }, 1000);
}

function finishRound() {
    state.status = 'RESOLVED';
    let dScore = state.dealer.score;
    let dealerNatural = (state.dealer.cards.length === 2 && dScore === 21);
    
    for(let i=1; i<=5; i++) {
        let s = state.seats[i];
        if (s && s.bet > 0) {
            let playerNatural = (s.cards.length === 2 && s.score === 21);
            if (s.status === 'BUST') { s.result = 'LOSS'; }
            else if (dealerNatural && !playerNatural) { s.result = 'LOSS'; }
            else if (playerNatural && !dealerNatural) { s.result = 'WIN'; } // Blackjack
            else if (dScore > 21 || s.score > dScore) { s.result = 'WIN'; }
            else if (s.score === dScore) { s.result = 'PUSH'; }
            else { s.result = 'LOSS'; }
        }
    }
    
    broadcastState();

    // Reset after 5 seconds
    setTimeout(() => {
        state.dealer = { cards: [], score: 0 };
        for(let i=1; i<=5; i++) {
            let s = state.seats[i];
            if (s) {
                if (s.bet === 0) { state.seats[i] = null; } // Kick idlers
                else {
                    s.cards = [];
                    s.score = 0;
                    s.bet = 0; // Reset bet for next round
                    s.status = 'WAITING';
                    s.result = null;
                }
            }
        }
        state.status = 'BETTING';
        state.timer = 15;
        state.activeSeat = null;
        broadcastState();
    }, 5000);
}

// MAIN ENGINE LOOP
setInterval(() => {
    if (state.status === 'BETTING') {
        let hasBets = Object.values(state.seats).some(s => s && s.bet > 0);
        if (hasBets) {
            state.timer--;
            if (state.timer <= 0) {
                state.status = 'DEALING';
                broadcastState();
                
                // Deal sequence
                let activeSeats = Object.keys(state.seats).filter(k => state.seats[k] !== null && state.seats[k].bet > 0);
                
                activeSeats.forEach(k => { state.seats[k].cards = [drawCard(), drawCard()]; state.seats[k].score = getScore(state.seats[k].cards); state.seats[k].status = state.seats[k].score === 21 ? 'STAND' : 'PLAYING'; });
                state.dealer.cards = [drawCard(), drawCard()];
                state.dealer.score = getScore(state.dealer.cards);
                
                setTimeout(() => {
                    state.status = 'PLAYER_TURN';
                    nextTurn();
                }, 2000);
                return;
            }
        } else {
            state.timer = 15; // Reset if no bets
        }
        broadcastState();
    } 
    else if (state.status === 'PLAYER_TURN') {
        state.timer--;
        if (state.timer <= 0) {
            // Auto-stand if time runs out
            if (state.activeSeat && state.seats[state.activeSeat]) {
                state.seats[state.activeSeat].status = 'STAND';
                nextTurn();
            }
        } else {
            broadcastState();
        }
    }
}, 1000);

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        socket.playerName = name;
        broadcastState();
    });

    socket.on('sendChat', (msg) => {
        if(socket.playerName) io.emit('chatMessage', { name: socket.playerName, msg: msg });
    });

    socket.on('takeSeat', (seatNum) => {
        if (!socket.playerName || state.seats[seatNum] || state.status !== 'BETTING') return;
        // Prevent sitting twice
        for(let i=1; i<=5; i++) { if(state.seats[i] && state.seats[i].name === socket.playerName) return; }
        
        state.seats[seatNum] = { name: socket.playerName, socketId: socket.id, bet: 0, cards: [], score: 0, status: 'WAITING' };
        broadcastState();
    });

    socket.on('leaveSeat', () => {
        if (state.status !== 'BETTING') return; // Can only leave during betting
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
            if (s && s.socketId === socket.id && s.bet === 0) {
                s.bet = amt;
                state.timer = 15; // Reset timer when someone bets to allow others
                broadcastState();
                break;
            }
        }
    });

    socket.on('playerAction', (action) => {
        if (state.status !== 'PLAYER_TURN' || !state.activeSeat) return;
        let seat = state.seats[state.activeSeat];
        if (!seat || seat.socketId !== socket.id) return; // Not their turn

        if (action === 'hit') {
            seat.cards.push(drawCard());
            seat.score = getScore(seat.cards);
            state.timer = 15;
            if (seat.score >= 21) {
                seat.status = seat.score > 21 ? 'BUST' : 'STAND';
                nextTurn();
            } else {
                broadcastState();
            }
        } 
        else if (action === 'stand') {
            seat.status = 'STAND';
            nextTurn();
        }
        else if (action === 'double') {
            if (seat.cards.length === 2) {
                seat.bet *= 2;
                seat.cards.push(drawCard());
                seat.score = getScore(seat.cards);
                seat.status = seat.score > 21 ? 'BUST' : 'STAND';
                nextTurn();
            }
        }
    });

    socket.on('disconnect', () => {
        // Find if they are in a seat
        for(let i=1; i<=5; i++) {
            if(state.seats[i] && state.seats[i].socketId === socket.id) {
                if (state.status === 'BETTING') {
                    state.seats[i] = null;
                } else {
                    // If game is running, auto-stand them and they will be kicked next round
                    state.seats[i].status = 'STAND';
                    if (state.activeSeat === i) nextTurn();
                }
                broadcastState();
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`♠️ VIP Blackjack Sandbox running on port ${PORT}`));
