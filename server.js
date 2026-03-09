require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let isMaintenanceMode = false;
let globalBankVault = 2000000;

let currentRadio = { url: null, startTime: 0, requestedBy: null };

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
        if (err) res.sendFile(path.join(__dirname, 'index.html'));
    });
});

const formatTC = (amount) => Math.round(amount * 10) / 10;

async function deductBet(user, betAmount) {
    let amt = formatTC(betAmount);
    let totalBal = formatTC((user.credits || 0) + (user.playableCredits || 0));
    
    if (amt <= 0 || totalBal < amt) return { success: false };

    let fromPlayable = 0;
    let fromMain = 0;

    if ((user.playableCredits || 0) >= amt) {
        fromPlayable = amt;
        user.playableCredits = formatTC(user.playableCredits - amt);
    } else {
        fromPlayable = user.playableCredits || 0;
        fromMain = formatTC(amt - fromPlayable);
        user.playableCredits = 0;
        user.credits = formatTC((user.credits || 0) - fromMain);
    }
    return { success: true, fromPlayable, fromMain };
}

function sendPulse(msg, type='info') {
    io.to('admin_room').emit('adminPulse', { msg, type, time: Date.now() });
}

async function processReferralBetCommission(user, betAmount) {
    if (!user.referredBy) return;
    let comm = formatTC(betAmount * 0.01);
    if (comm <= 0) return;
    
    try {
        let referrer = await User.findOne({ username: user.referredBy });
        if (referrer) {
            referrer.playableCredits = formatTC((referrer.playableCredits || 0) + comm);
            await referrer.save();
            
            let refSock = connectedUsers[referrer.username];
            if (refSock) {
                io.to(refSock).emit('balanceUpdateData', { credits: referrer.credits, playable: referrer.playableCredits });
            }
        }
    } catch(e) { console.error("Commission Error:", e); }
}

const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB Database');
        const adminExists = await User.findOne({ username: 'admin' });
        if (!adminExists) {
            await new User({ username: 'admin', password: 'Kenm44ashley', role: 'Admin', credits: 10000, playableCredits: 0 }).save();
        }
        pushAdminData(); 
    })
    .catch(err => { console.error('❌ MongoDB Connection Error.', err); });

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'Player' },
    credits: { type: Number, default: 0 }, 
    playableCredits: { type: Number, default: 0 }, 
    status: { type: String, default: 'Offline' },
    ipAddress: { type: String, default: 'Unknown' },
    joinDate: { type: Date, default: Date.now },
    referredBy: { type: String, default: null }, 
    dailyReward: { lastClaim: { type: Date, default: null }, streak: { type: Number, default: 0 } }
});
const User = mongoose.model('User', userSchema);

const txSchema = new mongoose.Schema({
    username: String, type: String, amount: Number, ref: String,
    status: { type: String, default: 'Pending' }, date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', txSchema);

const codeSchema = new mongoose.Schema({
    batchId: String, amount: Number, code: String, creditType: { type: String, default: 'playable' },
    redeemedBy: { type: String, default: null }, date: { type: Date, default: Date.now }
});
const GiftCode = mongoose.model('GiftCode', codeSchema);

const creditLogSchema = new mongoose.Schema({
    username: String, action: String, amount: Number, details: String, date: { type: Date, default: Date.now }
});
const CreditLog = mongoose.model('CreditLog', creditLogSchema);

const adminLogSchema = new mongoose.Schema({
    adminName: String, action: String, details: String, date: { type: Date, default: Date.now }
});
const AdminLog = mongoose.model('AdminLog', adminLogSchema);

let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0, horserace: 0, mbj: 0 };
let sharedTables = { time: 15, status: 'BETTING', bets: [] };

// ---------------- RETRO DERBY STATE ----------------
let hrState = { time: 30, status: 'BETTING', bets: [], currentOdds: {} };

function generateHorseOdds() {
    const baseMultipliers = [2, 4, 6, 11, 16, 31];
    const horses = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange'];
    // Shuffle the multipliers
    for (let i = baseMultipliers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [baseMultipliers[i], baseMultipliers[j]] = [baseMultipliers[j], baseMultipliers[i]];
    }
    let oddsMap = {}; horses.forEach((h, index) => { oddsMap[h] = baseMultipliers[index]; });
    hrState.currentOdds = oddsMap;
}
generateHorseOdds(); // Setup initial odds


// ---------------- 5-SEAT MULTIPLAYER BLACKJACK STATE ----------------
let mbjState = {
    status: 'BETTING', time: 15, turnTimer: 0, currentTurn: null, activeOrder: [],
    dealer: { hand: [], score: 0 },
    seats: { 1: null, 2: null, 3: null, 4: null, 5: null } // { userId, socketId, username, bet, hand, status, score, pushPlayable, pushMain }
};

let connectedUsers = {}; 
let globalResults = { baccarat: [], perya: [], dt: [], sicbo: [], horserace: [], mbj: [] }; 

let gameStats = {
    baccarat: { total: 0, Player: 0, Banker: 0, Tie: 0 },
    dt: { total: 0, Dragon: 0, Tiger: 0, Tie: 0 },
    sicbo: { total: 0, Big: 0, Small: 0, Triple: 0 },
    perya: { total: 0, Yellow: 0, White: 0, Pink: 0, Blue: 0, Red: 0, Green: 0 },
    horserace: { total: 0, Red: 0, Blue: 0, Green: 0, Yellow: 0, Purple: 0, Orange: 0 },
    coinflip: { total: 0, Heads: 0, Tails: 0 },
    d20: { total: 0, Win: 0, Lose: 0 },
    blackjack: { total: 0, Win: 0, Lose: 0, Push: 0 }
};

function logGlobalResult(game, resultStr) {
    if(globalResults[game]) {
        globalResults[game].unshift({ result: resultStr, time: new Date() });
        if (globalResults[game].length > 5) globalResults[game].pop(); 
    }
}
function checkResetStats(game) {
    if (gameStats[game].total >= 100) { Object.keys(gameStats[game]).forEach(key => { gameStats[game][key] = 0; }); }
}

function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const ss = ['♠','♣','♥','♦'];
    let v = vs[crypto.randomInt(vs.length)];
    let s = ss[crypto.randomInt(ss.length)];
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    let dt = 0;
    if (v === 'A') dt = 1; else if (v === 'K') dt = 13; else if (v === 'Q') dt = 12; else if (v === 'J') dt = 11; else dt = parseInt(v);
    let suitHtml = (s === '♥' || s === '♦') ? `<span class="card-red">${s}</span>` : s;
    return { val: v, suit: s, bacVal: bac, bjVal: bj, dtVal: dt, raw: v, suitHtml: suitHtml };
}

function getBJScore(hand) {
    let score = 0, aces = 0;
    for (let card of hand) { score += card.bjVal; if (card.raw === 'A') aces += 1; }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

// ---------------- STANDARD SHARED TABLES ENGINE ----------------
setInterval(() => {
    if (sharedTables.status === 'BETTING') {
        sharedTables.time--;
        io.emit('timerUpdate', sharedTables.time);

        if (sharedTables.time <= 0) {
            sharedTables.status = 'RESOLVING';
            io.emit('lockBets');

            setTimeout(async () => {
                let dtD = drawCard(), dtT = drawCard();
                let dtWin = dtD.dtVal > dtT.dtVal ? 'Dragon' : (dtT.dtVal > dtD.dtVal ? 'Tiger' : 'Tie');
                let dtResStr = dtWin === 'Tie' ? `TIE (${dtD.raw} TO ${dtT.raw})` : `${dtWin.toUpperCase()} (${dtD.raw} TO ${dtT.raw})`;
                
                let sbR = [crypto.randomInt(1, 7), crypto.randomInt(1, 7), crypto.randomInt(1, 7)];
                let sbSum = sbR[0] + sbR[1] + sbR[2];
                let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
                let sbWin = sbTrip ? 'Triple' : (sbSum <= 10 ? 'Small' : 'Big');
                let sbResStr = sbTrip ? `TRIPLE (${sbR[0]})` : `${sbWin.toUpperCase()} (${sbSum})`;

                const cols = ['Yellow','White','Pink','Blue','Red','Green'];
                let pyR = [cols[crypto.randomInt(6)], cols[crypto.randomInt(6)], cols[crypto.randomInt(6)]];

                let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
                let pS = (pC[0].bacVal + pC[1].bacVal) % 10;
                let bS = (bC[0].bacVal + bC[1].bacVal) % 10;
                let p3Drawn = false, b3Drawn = false;

                if (pS < 8 && bS < 8) {
                    let p3Val = -1;
                    if (pS <= 5) { pC.push(drawCard()); p3Val = pC[2].bacVal; pS = (pS + p3Val) % 10; p3Drawn = true; }
                    let bDraws = false;
                    if (pC.length === 2) { if (bS <= 5) bDraws = true; } 
                    else {
                        if (bS <= 2) bDraws = true;
                        else if (bS === 3 && p3Val !== 8) bDraws = true;
                        else if (bS === 4 && p3Val >= 2 && p3Val <= 7) bDraws = true;
                        else if (bS === 5 && p3Val >= 4 && p3Val <= 7) bDraws = true;
                        else if (bS === 6 && (p3Val === 6 || p3Val === 7)) bDraws = true;
                    }
                    if (bDraws) { bC.push(drawCard()); bS = (bS + bC[bC.length-1].bacVal) % 10; b3Drawn = true; }
                }
                let bacWin = pS > bS ? 'Player' : (bS > pS ? 'Banker' : 'Tie');
                let bacResStr = bacWin === 'Tie' ? `TIE (${pS} TO ${bS})` : `${bacWin.toUpperCase()} (${pS} TO ${bS})`;

                let playerStats = {}; 
                sharedTables.bets.forEach(b => {
                    let payout = 0;
                    let isPush = false;

                    if (b.room === 'dt') { 
                        if (dtWin === 'Tie') { 
                            if (b.choice === 'Tie') payout = b.amount * 9; 
                            else isPush = true; 
                        } 
                        else { if (b.choice === dtWin) payout = b.amount * 2; }
                    } 
                    else if (b.room === 'sicbo') { 
                        if (b.choice === sbWin) payout = b.amount * 2; 
                    } 
                    else if (b.room === 'perya') {
                        let matches = pyR.filter(c => c === b.choice).length;
                        if (matches > 0) payout = b.amount + (b.amount * matches);
                    } 
                    else if (b.room === 'baccarat') {
                        if (bacWin === 'Tie') { 
                            if (b.choice === 'Tie') payout = b.amount * 9; 
                            else if (b.choice === 'Player' || b.choice === 'Banker') isPush = true; 
                        } 
                        else if (bacWin === 'Player') { if (b.choice === 'Player') payout = b.amount * 2; } 
                        else if (bacWin === 'Banker') { if (b.choice === 'Banker') payout = b.amount * 1.95; }
                    }

                    if (!playerStats[b.userId]) playerStats[b.userId] = { socketId: b.socketId, username: b.username, amountWon: 0, amountBet: 0, room: b.room, pushPlayable: 0, pushMain: 0 };
                    
                    playerStats[b.userId].amountBet += b.amount;
                    if (isPush) {
                        playerStats[b.userId].pushPlayable += b.fromPlayable;
                        playerStats[b.userId].pushMain += b.fromMain;
                    } else {
                        playerStats[b.userId].amountWon += formatTC(payout);
                    }
                });

                let roomNames = { 'perya': 'Color Game', 'dt': 'Dragon Tiger', 'sicbo': 'Sic Bo', 'baccarat': 'Baccarat' };

                Object.keys(playerStats).forEach(async (userId) => {
                    let st = playerStats[userId];
                    let user = await User.findById(userId);
                    if (user) {
                        if (st.pushPlayable > 0) user.playableCredits = formatTC((user.playableCredits || 0) + st.pushPlayable);
                        if (st.pushMain > 0) user.credits = formatTC((user.credits || 0) + st.pushMain);
                        if (st.amountWon > 0) user.credits = formatTC((user.credits || 0) + st.amountWon);
                        await user.save();
                        
                        let nonPushBet = st.amountBet - (st.pushPlayable + st.pushMain);
                        let net = formatTC(st.amountWon - nonPushBet);
                        if (net !== 0) {
                            await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: roomNames[st.room] }).save();
                        }
                    }
                });

                io.to('dt').emit('sharedResults', { room: 'dt', dCard: dtD, tCard: dtT, winner: dtWin, resStr: dtResStr });
                io.to('sicbo').emit('sharedResults', { room: 'sicbo', roll: sbR, sum: sbSum, winner: sbWin, resStr: sbResStr });
                io.to('perya').emit('sharedResults', { room: 'perya', roll: pyR });
                io.to('baccarat').emit('sharedResults', { room: 'baccarat', pCards: pC, bCards: bC, pScore: pS, bScore: bS, winner: bacWin, resStr: bacResStr, p3Drawn: p3Drawn, b3Drawn: b3Drawn });

                setTimeout(() => { logGlobalResult('dt', dtResStr); gameStats.dt.total++; gameStats.dt[dtWin]++; checkResetStats('dt'); }, 2500);
                setTimeout(() => { logGlobalResult('sicbo', sbResStr); gameStats.sicbo.total++; gameStats.sicbo[sbWin]++; checkResetStats('sicbo'); }, 2500);
                setTimeout(() => { logGlobalResult('perya', pyR.join(',')); gameStats.perya.total++; pyR.forEach(c => gameStats.perya[c]++); checkResetStats('perya'); }, 2500);
                setTimeout(() => { logGlobalResult('baccarat', bacResStr); gameStats.baccarat.total++; gameStats.baccarat[bacWin]++; checkResetStats('baccarat'); }, 4500);

            }, 500);

            setTimeout(() => {
                sharedTables.time = 15;
                sharedTables.status = 'BETTING';
                sharedTables.bets = [];
                io.emit('newRound'); 
                pushAdminData();
            }, 9000); 
        }
    }
}, 1000);

// ---------------- RETRO DERBY ENGINE (15 SECONDS) ----------------
setInterval(() => {
    if (hrState.status === 'BETTING') {
        hrState.time--;
        io.emit('hrTimerUpdate', { time: hrState.time, odds: hrState.currentOdds });

        if (hrState.time <= 0) {
            hrState.status = 'RACING';
            io.emit('hrLockBets');

            setTimeout(async () => {
                const horses = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange'];
                
                // Weighted Randomness calculation based on dynamic odds
                let weights = horses.map(h => ({ horse: h, weight: 1 / hrState.currentOdds[h] }));
                let totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
                let randomVal = Math.random() * totalWeight;
                let winner = weights[0].horse;
                let cumulative = 0;
                
                for(let w of weights) {
                    cumulative += w.weight;
                    if(randomVal <= cumulative) {
                        winner = w.horse;
                        break;
                    }
                }

                // Fire 15-second race animation to clients
                io.emit('hrRaceStart', { winner: winner, duration: 15000 });

                // Process Payouts after 15.5 seconds
                setTimeout(async () => {
                    let playerStats = {}; 
                    hrState.bets.forEach(b => {
                        let payout = 0;
                        if (b.choice === winner) payout = b.amount * hrState.currentOdds[winner];

                        if (!playerStats[b.userId]) playerStats[b.userId] = { socketId: b.socketId, username: b.username, amountWon: 0, amountBet: 0 };
                        playerStats[b.userId].amountBet += b.amount;
                        playerStats[b.userId].amountWon += formatTC(payout);
                    });

                    Object.keys(playerStats).forEach(async (userId) => {
                        let st = playerStats[userId];
                        let user = await User.findById(userId);
                        if (user) {
                            if (st.amountWon > 0) user.credits = formatTC((user.credits || 0) + st.amountWon);
                            await user.save();
                            let net = formatTC(st.amountWon - st.amountBet);
                            if (net !== 0) await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: 'Retro Derby' }).save();
                        }
                    });

                    io.emit('hrRaceResults', { winner: winner, payoutMult: hrState.currentOdds[winner] });
                    
                    setTimeout(() => {
                        logGlobalResult('horserace', winner);
                        gameStats.horserace.total++;
                        gameStats.horserace[winner]++;
                        checkResetStats('horserace');
                    }, 2000);

                }, 15500);

                // Reset phase
                setTimeout(() => {
                    generateHorseOdds();
                    hrState.time = 30;
                    hrState.status = 'BETTING';
                    hrState.bets = [];
                    io.emit('hrNewRound', { odds: hrState.currentOdds }); 
                    pushAdminData();
                }, 21000); 
            }, 500);
        }
    }
}, 1000);

// ---------------- 5-SEAT MULTIPLAYER BLACKJACK ENGINE ----------------
function mbjNextTurn() {
    let idx = mbjState.activeOrder.indexOf(mbjState.currentTurn);
    if (idx + 1 < mbjState.activeOrder.length) {
        mbjState.currentTurn = mbjState.activeOrder[idx + 1];
        mbjState.turnTimer = 10;
        io.to('mbj').emit('mbjUpdate', { event: 'turn', currentTurn: mbjState.currentTurn, time: mbjState.turnTimer });
    } else {
        mbjResolveDealer();
    }
}

async function mbjResolveDealer() {
    mbjState.status = 'RESOLVING';
    
    let dScore = getBJScore(mbjState.dealer.hand);
    while (dScore < 17) {
        mbjState.dealer.hand.push(drawCard());
        dScore = getBJScore(mbjState.dealer.hand);
    }
    mbjState.dealer.score = dScore;

    let payouts = {};
    for (let s in mbjState.seats) {
        let seat = mbjState.seats[s];
        if (seat && seat.bet > 0 && seat.status !== 'BUST') {
            let pScore = getBJScore(seat.hand);
            let payout = 0, isPush = false;
            
            if (seat.status === 'BLACKJACK') {
                if (dScore === 21 && mbjState.dealer.hand.length === 2) isPush = true;
                else payout = seat.bet * 2.5;
            } else if (dScore > 21 || pScore > dScore) {
                payout = seat.bet * 2;
            } else if (pScore === dScore) {
                isPush = true;
            }

            payouts[s] = { payout, isPush };
            
            let user = await User.findById(seat.userId);
            if (user) {
                if (isPush) {
                    user.playableCredits = formatTC((user.playableCredits || 0) + seat.pushPlayable);
                    user.credits = formatTC((user.credits || 0) + seat.pushMain);
                } else if (payout > 0) {
                    user.credits = formatTC((user.credits || 0) + payout);
                }
                await user.save();
                
                let net = isPush ? 0 : formatTC(payout - seat.bet);
                if (net !== 0) {
                    await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: '5-Seat Blackjack' }).save();
                }
                
                if (connectedUsers[user.username]) io.to(connectedUsers[user.username]).emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
            }
        } else if (seat && seat.bet > 0 && seat.status === 'BUST') {
            let user = await User.findById(seat.userId);
            if(user) {
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(-seat.bet), details: '5-Seat Blackjack' }).save();
            }
        }
    }

    io.to('mbj').emit('mbjUpdate', { event: 'dealer_resolved', dealerHand: mbjState.dealer.hand, dealerScore: dScore, payouts, seats: mbjState.seats });
    
    setTimeout(() => {
        // Reset board for next round, keep players seated
        for (let s in mbjState.seats) {
            if (mbjState.seats[s]) {
                if (mbjState.seats[s].bet === 0) mbjState.seats[s] = null;
                else {
                    mbjState.seats[s].bet = 0; mbjState.seats[s].hand = []; mbjState.seats[s].status = 'WAITING';
                }
            }
        }
        mbjState.dealer.hand = []; mbjState.time = 15; mbjState.status = 'BETTING';
        io.to('mbj').emit('mbjUpdate', { event: 'new_round', seats: mbjState.seats });
    }, 7000);
}

setInterval(() => {
    if (mbjState.status === 'BETTING') {
        mbjState.time--;
        io.to('mbj').emit('mbjUpdate', { event: 'timer', time: mbjState.time });
        
        if (mbjState.time <= 0) {
            let activeSeats = Object.keys(mbjState.seats).filter(k => mbjState.seats[k] && mbjState.seats[k].bet > 0);
            
            if (activeSeats.length === 0) {
                mbjState.time = 15; // Reset if empty
            } else {
                mbjState.status = 'DEALING';
                io.to('mbj').emit('mbjUpdate', { event: 'lock_bets' });
                
                mbjState.dealer.hand = [drawCard(), drawCard()];
                activeSeats.forEach(k => {
                    mbjState.seats[k].hand = [drawCard(), drawCard()];
                    let score = getBJScore(mbjState.seats[k].hand);
                    mbjState.seats[k].status = score === 21 ? 'BLACKJACK' : 'PLAYING';
                    mbjState.seats[k].score = score;
                });

                let hiddenDealer = [mbjState.dealer.hand[0], { raw: '?', suitHtml: '<span class="card-back">?</span>', bjVal: 0 }];
                io.to('mbj').emit('mbjUpdate', { event: 'deal', seats: mbjState.seats, dealerHand: hiddenDealer });

                setTimeout(() => {
                    mbjState.activeOrder = activeSeats.filter(k => mbjState.seats[k].status === 'PLAYING');
                    if (mbjState.activeOrder.length > 0) {
                        mbjState.status = 'PLAYER_TURN';
                        mbjState.currentTurn = mbjState.activeOrder[0];
                        mbjState.turnTimer = 10;
                        io.to('mbj').emit('mbjUpdate', { event: 'turn', currentTurn: mbjState.currentTurn, time: mbjState.turnTimer });
                    } else {
                        mbjResolveDealer();
                    }
                }, 3000);
            }
        }
    } else if (mbjState.status === 'PLAYER_TURN') {
        mbjState.turnTimer--;
        io.to('mbj').emit('mbjUpdate', { event: 'turn_timer', time: mbjState.turnTimer });
        if (mbjState.turnTimer <= 0) {
            mbjState.seats[mbjState.currentTurn].status = 'STAND';
            mbjNextTurn();
        }
    }
}, 1000);


async function pushAdminData(targetSocket = null) {
    try {
        const users = await User.find(); 
        const txs = await Transaction.find().sort({ date: -1 }); 
        const gcs = await GiftCode.find().sort({ date: -1 });
        
        let totalMainCredits = formatTC(users.reduce((a, b) => a + (b.credits || 0), 0)); 
        let approvedDeposits = txs.filter(t => t.type === 'Deposit' && t.status === 'Approved').reduce((a, b) => a + b.amount, 0);
        let approvedWithdrawals = txs.filter(t => t.type === 'Withdrawal' && t.status === 'Approved').reduce((a, b) => a + b.amount, 0);

        globalBankVault = formatTC(2000000 + approvedDeposits - approvedWithdrawals - totalMainCredits);

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const gameLogs = await CreditLog.find({ action: 'GAME', date: { $gte: oneDayAgo } });
        let playerNet = gameLogs.reduce((sum, l) => sum + l.amount, 0);
        let houseProfit24h = formatTC(-playerNet);

        const adminLogs = await AdminLog.find().sort({ date: -1 }).limit(100);

        let payload = { 
            users, 
            transactions: txs, 
            giftBatches: gcs, 
            adminLogs,
            stats: { economy: totalMainCredits, approvedDeposits: formatTC(approvedDeposits), limit: globalBankVault, houseProfit: houseProfit24h },
            isMaintenance: isMaintenanceMode
        };

        if(targetSocket) { targetSocket.emit('adminDataSync', payload); }
        else { io.to('admin_room').emit('adminDataSync', payload); }
        
    } catch(e) { console.error(e); }
}

io.on('connection', (socket) => {
    socket.emit('timerUpdate', sharedTables.time);
    socket.emit('hrTimerUpdate', { time: hrState.time, odds: hrState.currentOdds });
    socket.emit('maintenanceToggle', isMaintenanceMode); 
    socket.emit('radioSync', currentRadio); 

    socket.isBetting = false;
    socket.isSharedBetting = false;
    socket.isCashier = false;
    socket.isAuth = false;

    socket.on('requestBalanceRefresh', async () => {
        if(socket.user) {
            let u = await User.findById(socket.user._id);
            if(u) socket.emit('balanceUpdateData', { credits: formatTC(u.credits), playable: formatTC(u.playableCredits) });
        }
    });

    socket.on('getWalletLogs', async () => {
        if(socket.user) {
            const logs = await CreditLog.find({ username: socket.user.username }).sort({ date: -1 }).limit(50);
            const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
            const todayLogs = await CreditLog.find({ username: socket.user.username, date: { $gte: startOfDay }});
            let dailyProfit = 0;
            todayLogs.forEach(l => { if (l.action === 'GAME') dailyProfit += l.amount; });
            socket.emit('walletLogsData', { logs, dailyProfit: formatTC(dailyProfit) });
        }
    });

    socket.on('clearWalletLogs', async () => {
        if(socket.user) {
            await CreditLog.deleteMany({ username: socket.user.username });
            socket.emit('walletLogsData', { logs: [], dailyProfit: 0 });
        }
    });

    socket.on('fetchUserLogs', async (username) => {
        if (!socket.rooms.has('admin_room')) return;
        const logs = await CreditLog.find({ username }).sort({ date: -1 }).limit(100);
        socket.emit('userLogsData', { username, logs });
    });

    socket.on('playSolo', async (data) => {
        if (isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.game });
        if (!socket.user) return;
        if (socket.isBetting) return; 
        socket.isBetting = true;

        try {
            const user = await User.findById(socket.user._id);
            if (!user) return;
            
            let isNewBet = (data.game === 'd20' || data.game === 'coinflip' || (data.game === 'blackjack' && data.action === 'start'));
            
            if (isNewBet) {
                let amt = formatTC(data.bet || 0);
                let maxPotentialMultiplier = 1;

                if (data.game === 'd20') {
                    if (!Array.isArray(data.bets) || data.bets.length === 0) { socket.emit('localGameError', { msg: 'Select at least one bet', game: 'd20' }); return; }
                    let totalD20Bet = 0;
                    for (let b of data.bets) {
                        let a = formatTC(b.amount);
                        if(isNaN(a) || a < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: 'd20' }); return; }
                        totalD20Bet += a;
                    }
                    amt = totalD20Bet;
                    maxPotentialMultiplier = 1.95 * data.bets.length; 
                } else {
                    if (isNaN(amt) || amt < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.game }); return; }
                    if (data.game === 'coinflip') maxPotentialMultiplier = 1.95;
                    if (data.game === 'blackjack') maxPotentialMultiplier = 2.5;
                }
                
                if (amt > 50000) { socket.emit('localGameError', { msg: 'MAX TOTAL BET IS 50K TC', game: data.game }); return; }

                if (!socket.soloBaseline) socket.soloBaseline = { game: null, amount: 0, active: false };

                if (!socket.soloBaseline.active || socket.soloBaseline.game !== data.game) {
                    socket.soloBaseline = { game: data.game, amount: amt, active: true };
                } else {
                    let spreadLimit = socket.soloBaseline.amount * 8; 
                    if (amt > spreadLimit && amt > 500) { 
                        socket.emit('localGameError', { msg: `MARTINGALE CAP: MAX ${formatTC(spreadLimit)} TC ON THIS STREAK`, game: data.game });
                        return;
                    }
                }
                
                if ((amt * maxPotentialMultiplier) > globalBankVault) {
                    socket.emit('localGameError', { msg: 'VAULT LIMIT REACHED. CANNOT COVER BET.', game: data.game }); return;
                }

                if (data.game === 'coinflip') {
                    if (data.choice !== 'Heads' && data.choice !== 'Tails') { socket.emit('localGameError', { msg: 'INVALID CHOICE', game: 'coinflip' }); return; }
                }
                
                let deduction = await deductBet(user, amt);
                if (!deduction.success) {
                    socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.game }); return;
                }
                await user.save();
                sendPulse(`${user.username} bet ${amt} TC on ${data.game.toUpperCase()}`, 'bet');

                processReferralBetCommission(user, amt);

                if (data.game === 'blackjack') {
                    socket.bjState = { 
                        bet: amt, 
                        pHand: [drawCard(), drawCard()], 
                        dHand: [drawCard(), drawCard()],
                        fromPlayable: deduction.fromPlayable,
                        fromMain: deduction.fromMain
                    };
                }
            }

            let payout = 0;

            if (data.game === 'd20') {
                let roll = crypto.randomInt(1, 21);
                let wonAny = false;
                let wonProfit = 0;
                let lostBet = 0;
                
                for(let b of data.bets) {
                    let win = false;
                    let val = b.guessValue;
                    if (val === 'high' && roll >= 11) win = true;
                    if (val === 'low' && roll <= 10) win = true;
                    if (val === 'even' && roll % 2 === 0) win = true;
                    if (val === 'odd' && roll % 2 !== 0) win = true;
                    
                    if(win) { 
                        payout += formatTC(b.amount * 1.95); 
                        wonAny = true; 
                        wonProfit += formatTC(b.amount * 0.95); 
                    } else { 
                        lostBet += formatTC(b.amount); 
                    }
                }
                payout = formatTC(payout);
                
                if (payout > 0 && socket.soloBaseline) socket.soloBaseline.active = false;

                user.credits = formatTC(user.credits + payout); await user.save();
                let net = formatTC(payout - data.bet);
                await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: `D20` }).save();
                
                pushAdminData();
                socket.emit('d20Result', { roll, payout, bet: data.bet, resStr: `ROLLED ${roll}`, newBalance: { credits: user.credits, playable: user.playableCredits }, wonProfit, lostBet });
                
                setTimeout(() => {
                    gameStats.d20.total++;
                    if (wonAny) gameStats.d20.Win++; else gameStats.d20.Lose++;
                    checkResetStats('d20');
                }, 2000);
            } 
            else if (data.game === 'coinflip') {
                let result = crypto.randomInt(2) === 0 ? 'Heads' : 'Tails';
                if (data.choice === result) {
                    payout = formatTC(data.bet * 1.95);
                    if (socket.soloBaseline) socket.soloBaseline.active = false;
                }
                
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `Coin Flip` }).save();
                
                let resStr = `${result.toUpperCase()}`;
                pushAdminData();
                socket.emit('coinResult', { result, payout, bet: data.bet, resStr: resStr, newBalance: { credits: user.credits, playable: user.playableCredits }});
                
                setTimeout(() => {
                    gameStats.coinflip.total++; gameStats.coinflip[result]++; checkResetStats('coinflip');
                }, 2000);
            }
            else if (data.game === 'blackjack') {
                if (data.action === 'start') {
                    let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                    
                    if (pS === 21) {
                        if (socket.soloBaseline) socket.soloBaseline.active = false;

                        let msg = dS === 21 ? 'Push' : 'Blackjack!';
                        payout = formatTC(dS === 21 ? socket.bjState.bet : socket.bjState.bet * 2.5);
                        
                        if (msg === 'Push') {
                            user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable);
                            user.credits = formatTC(user.credits + socket.bjState.fromMain);
                        } else { user.credits = formatTC(user.credits + payout); }
                        await user.save();

                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                        let resStr = `${msg.toUpperCase()} (${pS} TO ${dS})`;
                        
                        pushAdminData();
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, naturalBJ: true, payout, msg, resStr: resStr, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits }});
                        socket.bjState = null;

                        setTimeout(() => {
                            gameStats.blackjack.total++; 
                            if(msg === 'Blackjack!') gameStats.blackjack.Win++; else gameStats.blackjack.Push++;
                            checkResetStats('blackjack');
                        }, 2500);

                    } else {
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand });
                    }
                }
                else if (data.action === 'hit') {
                    if(!socket.bjState) return;
                    socket.bjState.pHand.push(drawCard());
                    let pS = getBJScore(socket.bjState.pHand);
                    
                    if (pS > 21) {
                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(-socket.bjState.bet), details: `Blackjack` }).save();
                        let resStr = `PLAYER BUSTS!`;
                        
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust!', resStr: resStr, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                        socket.bjState = null;
                        
                        setTimeout(() => { gameStats.blackjack.total++; gameStats.blackjack.Lose++; checkResetStats('blackjack'); }, 2500);
                    } else { socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand }); }
                }
                else if (data.action === 'stand') {
                    if(!socket.bjState) return;
                    let pS = getBJScore(socket.bjState.pHand);
                    while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                    let dS = getBJScore(socket.bjState.dHand);
                    let msg = '';
                    
                    if (dS > 21 || pS > dS) { payout = formatTC(socket.bjState.bet * 2); msg = 'You Win!'; } 
                    else if (pS === dS) { payout = formatTC(socket.bjState.bet); msg = 'Push'; } 
                    else { msg = 'Dealer Wins'; }
                    
                    if (msg === 'You Win!' || msg === 'Push') {
                        if (socket.soloBaseline) socket.soloBaseline.active = false;
                    }

                    if (msg === 'Push') {
                        user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable);
                        user.credits = formatTC(user.credits + socket.bjState.fromMain);
                    } else { user.credits = formatTC(user.credits + payout); }
                    await user.save();

                    await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                    
                    let resStr = (dS > 21) ? `DEALER BUSTS!` : (msg === 'Push' ? `TIE (${dS} TO ${pS})` : (msg === 'You Win!' ? `PLAYER (${dS} TO ${pS})` : `DEALER (${dS} TO ${pS})`));
                    
                    pushAdminData();
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr: resStr, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                    socket.bjState = null;

                    setTimeout(() => { 
                        gameStats.blackjack.total++;
                        if (dS > 21 || pS > dS) gameStats.blackjack.Win++;
                        else if (pS === dS) gameStats.blackjack.Push++;
                        else gameStats.blackjack.Lose++;
                        checkResetStats('blackjack'); 
                    }, 2500);
                }
            }
        } finally {
            socket.isBetting = false; 
        }
    });

    socket.on('joinRoom', (room) => { 
        if(socket.currentRoom) { socket.leave(socket.currentRoom); rooms[socket.currentRoom]--; }
        socket.join(room); socket.currentRoom = room; rooms[room]++; 
        io.emit('playerCount', rooms); 
    });
    
    socket.on('leaveRoom', (room) => { 
        socket.leave(room); socket.currentRoom = null;
        if (rooms[room] > 0) rooms[room]--; 
        io.emit('playerCount', rooms); 
    });
    
    socket.on('sendChat', (data) => { 
        if (!socket.user) return;
        
        if (data.msg.startsWith('/play ')) {
            if (socket.user.role !== 'Admin' && socket.user.role !== 'VIP') {
                if (socket.currentRoom) io.to(socket.id).emit('chatMessage', { user: 'System', text: 'Only VIPs and Admins can use the DJ Radio.', sys: true });
                return;
            }
            let url = data.msg.replace('/play ', '').trim();
            currentRadio = { url, startTime: Date.now(), requestedBy: socket.user.username };
            io.emit('radioPlay', currentRadio);
            io.emit('globalChatMessage', { sys: true, text: `🎵 [RADIO] ${socket.user.username} started playing a track!` });
            return;
        }
        
        if (data.msg === '/stop') {
            if (socket.user.role !== 'Admin' && socket.user.role !== 'VIP') return;
            currentRadio = { url: null, startTime: 0, requestedBy: null };
            io.emit('radioStop');
            io.emit('globalChatMessage', { sys: true, text: `🎵 [RADIO] DJ turned off by ${socket.user.username}.` });
            return;
        }

        if (socket.currentRoom) { 
            io.to(socket.currentRoom).emit('chatMessage', { user: socket.user.username, text: data.msg, sys: false }); 
        } 
    });
    
    socket.on('getRoomPlayers', (room) => {
        let playersInRoom = [];
        for (let username in connectedUsers) {
            let sId = connectedUsers[username];
            let s = io.sockets.sockets.get(sId);
            if (s && s.rooms.has(room)) {
                playersInRoom.push(username);
            }
        }
        socket.emit('roomPlayersList', playersInRoom);
    });
    
    socket.on('placeSharedBet', async (data) => {
        if (isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.room });
        if (!socket.user) return;
        
        let targetState = data.room === 'horserace' ? hrState : sharedTables;
        if (targetState.status !== 'BETTING') return socket.emit('localGameError', { msg: 'Bets are closed!', game: data.room });
        
        if (socket.isSharedBetting) return;
        socket.isSharedBetting = true;
        
        try {
            const user = await User.findById(socket.user._id);
            if (!user) return;

            let amt = formatTC(data.amount);
            if (isNaN(amt) || amt < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.room }); return; }

            let currentTileBet = targetState.bets
                .filter(b => b.userId.toString() === user._id.toString() && b.room === data.room && b.choice === data.choice)
                .reduce((sum, b) => sum + b.amount, 0);

            if (currentTileBet + amt > 50000) {
                socket.emit('localGameError', { msg: 'MAX 50K TC PER TILE', game: data.room }); return;
            }

            let maxMultiplier = { 'baccarat': 9, 'dt': 9, 'sicbo': 2, 'perya': 4 }[data.room] || 2;
            if (data.room === 'horserace') maxMultiplier = hrState.currentOdds[data.choice];

            if ((amt * maxMultiplier) > globalBankVault) {
                socket.emit('localGameError', { msg: 'VAULT LIMIT REACHED. CANNOT COVER BET.', game: data.room }); return;
            }
            
            let deduction = await deductBet(user, amt);
            if (!deduction.success) {
                socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.room }); return;
            }
            await user.save();
            sendPulse(`${user.username} placed ${amt} TC on ${data.room.toUpperCase()}`, 'bet');

            processReferralBetCommission(user, amt);
            
            targetState.bets.push({ 
                userId: user._id, socketId: socket.id, username: user.username, room: data.room, choice: data.choice, amount: amt, fromPlayable: deduction.fromPlayable, fromMain: deduction.fromMain 
            });

            socket.emit('sharedBetConfirmed', { 
                choice: data.choice, 
                amount: amt, 
                room: data.room, 
                newBalance: { credits: user.credits, playable: user.playableCredits } 
            });

        } finally {
            socket.isSharedBetting = false;
        }
    });

    socket.on('undoSharedBet', async (data) => {
        if (!socket.user) return;
        
        let targetState = data.room === 'horserace' ? hrState : sharedTables;
        if (targetState.status !== 'BETTING') return;
        
        if (socket.isSharedBetting) return;
        socket.isSharedBetting = true;

        try {
            for (let i = targetState.bets.length - 1; i >= 0; i--) {
                let b = targetState.bets[i];
                if (b.userId.toString() === socket.user._id.toString() && b.room === data.room) {
                    let user = await User.findById(socket.user._id);
                    if (user) {
                        user.playableCredits = formatTC((user.playableCredits || 0) + b.fromPlayable);
                        user.credits = formatTC((user.credits || 0) + b.fromMain);
                        await user.save();
                        socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
                        socket.emit('undoSuccess', { choice: b.choice, amount: b.amount });
                    }
                    targetState.bets.splice(i, 1);
                    break;
                }
            }
        } finally {
            socket.isSharedBetting = false;
        }
    });

    // --- MULTIPLAYER BLACKJACK ROUTES ---
    socket.on('mbjTakeSeat', (seatNum) => {
        if (!socket.user || mbjState.seats[seatNum]) return;
        for(let s in mbjState.seats) { if (mbjState.seats[s] && mbjState.seats[s].userId.toString() === socket.user._id.toString()) return; }
        
        mbjState.seats[seatNum] = { userId: socket.user._id, socketId: socket.id, username: socket.user.username, bet: 0, hand: [], status: 'WAITING', pushPlayable: 0, pushMain: 0 };
        io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
    });

    socket.on('mbjLeaveSeat', async () => {
        if (!socket.user) return;
        for(let s in mbjState.seats) {
            let seat = mbjState.seats[s];
            if (seat && seat.userId.toString() === socket.user._id.toString()) {
                if (mbjState.status === 'BETTING') {
                    if (seat.bet > 0) {
                        let user = await User.findById(seat.userId);
                        if (user) {
                            user.playableCredits = formatTC((user.playableCredits || 0) + seat.pushPlayable);
                            user.credits = formatTC((user.credits || 0) + seat.pushMain);
                            await user.save();
                            socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
                        }
                    }
                    mbjState.seats[s] = null;
                    io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
                } else if (seat.bet === 0) {
                    mbjState.seats[s] = null;
                    io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
                }
                break;
            }
        }
    });

    socket.on('mbjPlaceBet', async (amount) => {
        if (!socket.user || mbjState.status !== 'BETTING') return;
        let seatNum = null;
        for(let s in mbjState.seats) { if (mbjState.seats[s] && mbjState.seats[s].userId.toString() === socket.user._id.toString()) seatNum = s; }
        if (!seatNum) return;

        let amt = formatTC(amount);
        if (isNaN(amt) || amt < 10) return socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: 'mbj' });
        
        const user = await User.findById(socket.user._id);
        let deduction = await deductBet(user, amt);
        if (!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: 'mbj' });
        await user.save();
        
        mbjState.seats[seatNum].bet += amt;
        mbjState.seats[seatNum].pushPlayable += deduction.fromPlayable;
        mbjState.seats[seatNum].pushMain += deduction.fromMain;
        
        socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
        io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
    });

    socket.on('mbjAction', (action) => {
        if (!socket.user || mbjState.status !== 'PLAYER_TURN' || mbjState.currentTurn === null) return;
        let seat = mbjState.seats[mbjState.currentTurn];
        if (seat.userId.toString() !== socket.user._id.toString()) return; 

        if (action === 'hit') {
            seat.hand.push(drawCard());
            seat.score = getBJScore(seat.hand);
            if (seat.score > 21) {
                seat.status = 'BUST';
                io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
                mbjNextTurn();
            } else {
                io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
            }
        } else if (action === 'stand') {
            seat.status = 'STAND';
            io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
            mbjNextTurn();
        }
    });

    socket.on('submitTransaction', async (data) => { 
        if (!socket.user) return;
        if (socket.isCashier) return;
        socket.isCashier = true;

        try {
            let amount = formatTC(data.amount);
            if(isNaN(amount) || amount <= 0) return;

            if (data.type === 'Deposit' && amount < 1000) { socket.emit('localGameError', { msg: 'MIN DEPOSIT IS 1,000 TC', game: 'cashier' }); return; }
            if (data.type === 'Withdrawal' && amount < 10000) { socket.emit('localGameError', { msg: 'MIN WITHDRAWAL IS 10,000 TC', game: 'cashier' }); return; }

            if (data.type === 'Deposit' && amount > 100000) { socket.emit('localGameError', { msg: 'MAX DEPOSIT IS 100,000 TC', game: 'cashier' }); return; }
            if (data.type === 'Withdrawal' && amount > 100000) { socket.emit('localGameError', { msg: 'MAX WITHDRAWAL IS 100,000 TC', game: 'cashier' }); return; }

            if(data.type === 'Withdrawal') {
                const user = await User.findOneAndUpdate({ _id: socket.user._id, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
                if (!user) { socket.emit('localGameError', { msg: 'Insufficient TC.', game: 'cashier' }); return; }
                socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
            }

            let tx = await new Transaction({ username: socket.user.username, type: data.type, amount: amount, ref: data.ref }).save(); 
            
            if(data.type === 'Withdrawal') {
                await new CreditLog({ username: socket.user.username, action: 'WITHDRAWAL', amount: -amount, details: `Pending` }).save();
            } else {
                await new CreditLog({ username: socket.user.username, action: 'DEPOSIT', amount: amount, details: `Pending` }).save();
            }
            sendPulse(`${socket.user.username} submitted a ${data.type} request for ${amount} TC.`, 'alert');
            const txs = await Transaction.find({ username: socket.user.username }).sort({ date: -1 });
            socket.emit('transactionsData', txs);
            pushAdminData(); 
        } finally {
            socket.isCashier = false;
        }
    });

    socket.on('adminLogin', async (data) => {
        try {
            if (mongoose.connection.readyState !== 1) { return socket.emit('authError', 'Database Offline. Try again later.'); }
            const user = await User.findOne({ username: data.username, password: data.password });
            if (user && (user.role === 'Admin' || user.role === 'Moderator')) {
                socket.join('admin_room'); 
                let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
                user.ipAddress = ip; await user.save();
                socket.user = user; 
                socket.emit('adminLoginSuccess', { username: user.username, role: user.role });
                await pushAdminData(socket);
            } else { socket.emit('authError', 'Invalid Admin Credentials.'); }
        } catch(e) { console.error("Admin Login Error:", e); socket.emit('authError', 'System Error: ' + e.message); }
    });

    socket.on('login', async (data) => {
        if (socket.isAuth) return;
        socket.isAuth = true;
        try {
            if (mongoose.connection.readyState !== 1) { return socket.emit('authError', 'Database Offline.'); }
            const user = await User.findOne({ username: data.username, password: data.password });
            if (!user) return socket.emit('authError', 'Invalid login credentials.');
            if (user.status === 'Banned') return socket.emit('authError', 'This account has been banned.');

            if (isNaN(user.credits) || user.credits === null) user.credits = 0;
            if (isNaN(user.playableCredits) || user.playableCredits === null) user.playableCredits = 0;

            let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            user.ipAddress = ip; user.status = 'Active'; await user.save(); 
            socket.user = user; connectedUsers[user.username] = socket.id;
            
            sendPulse(`${user.username} logged in.`, 'info');
            pushAdminData();
            
            let now = new Date(), canClaim = true, day = 1, nextClaim = null;
            if (user.dailyReward.lastClaim) {
                let diffHours = (now - user.dailyReward.lastClaim) / (1000 * 60 * 60);
                if (diffHours < 24) { canClaim = false; nextClaim = new Date(user.dailyReward.lastClaim.getTime() + 24 * 60 * 60 * 1000); } 
                else if (diffHours > 48) { user.dailyReward.streak = 0; }
                day = (user.dailyReward.streak % 7) + 1;
            }
            
            socket.emit('loginSuccess', { username: user.username, credits: formatTC(user.credits), playable: formatTC(user.playableCredits), role: user.role, daily: { canClaim, day, nextClaim } });
        } catch(e) { socket.emit('authError', 'System Error: ' + e.message); } finally { socket.isAuth = false; }
    });

    socket.on('register', async (data) => {
        if (socket.isAuth) return;
        socket.isAuth = true;
        try {
            if (mongoose.connection.readyState !== 1) { return socket.emit('authError', 'Database Offline.'); }
            const exists = await User.findOne({ username: data.username });
            if (exists) return socket.emit('authError', 'Username is already taken.');
            
            let refUser = null;
            if (data.referral) {
                refUser = await User.findOne({ username: new RegExp('^' + data.referral + '$', 'i') });
                if (!refUser) return socket.emit('authError', 'Invalid Referral Code.');
                if (refUser.username.toLowerCase() === data.username.toLowerCase()) return socket.emit('authError', 'Cannot refer yourself.');
            }
            
            let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            let newUser = new User({ 
                username: data.username, 
                password: data.password, 
                ipAddress: ip,
                referredBy: refUser ? refUser.username : null 
            });

            if (refUser) {
                newUser.playableCredits = 500;
                refUser.playableCredits = formatTC((refUser.playableCredits || 0) + 500);
                await refUser.save();
                
                await new CreditLog({ username: refUser.username, action: 'REFERRAL', amount: 500, details: `Signup Bonus (${newUser.username})` }).save();
                
                let refSock = connectedUsers[refUser.username];
                if (refSock) {
                    io.to(refSock).emit('balanceUpdateData', { credits: refUser.credits, playable: refUser.playableCredits });
                    io.to(refSock).emit('silentNotification', { id: Date.now(), title: 'Referral Bonus!', msg: `${newUser.username} used your code! +500 P`, date: new Date() });
                }
            }
            
            await newUser.save();
            if (refUser) {
                await new CreditLog({ username: newUser.username, action: 'REFERRAL', amount: 500, details: `Used code ${refUser.username}` }).save();
            }
            
            sendPulse(`New account created: ${data.username}`, 'success');
            pushAdminData();
            socket.emit('registerSuccess', 'Account created! You may now login.');
        } catch(e) { socket.emit('authError', 'System Error: ' + e.message); } finally { socket.isAuth = false; }
    });

    socket.on('claimDaily', async () => {
        if (!socket.user) return;
        const user = await User.findById(socket.user._id);
        let now = new Date();
        if (user.dailyReward.lastClaim && (now - user.dailyReward.lastClaim) / (1000 * 60 * 60) < 24) return; 

        let day = (user.dailyReward.streak % 7) + 1;
        const rewards = [100, 250, 500, 750, 1000, 1500, 2000];
        let amt = rewards[day - 1]; 

        if (user.role === 'VIP') { amt *= 2; }
        amt = formatTC(amt);

        user.playableCredits = formatTC((user.playableCredits || 0) + amt); 
        user.dailyReward.lastClaim = now; user.dailyReward.streak += 1; await user.save();
        
        await new CreditLog({ username: user.username, action: 'GIFT', amount: amt, details: `Daily Reward${user.role === 'VIP' ? ' (VIP 2x)' : ''}` }).save();
        sendPulse(`${user.username} claimed Day ${day} Daily Reward${user.role === 'VIP' ? ' (VIP 2x)' : ''}.`, 'info');
        pushAdminData();
        socket.emit('dailyClaimed', { amt, newBalance: { credits: user.credits, playable: user.playableCredits }, nextClaim: new Date(now.getTime() + 24 * 60 * 60 * 1000) });
    });

    socket.on('redeemPromo', async (code) => {
        if (!socket.user) return;
        try {
            const gc = await GiftCode.findOneAndUpdate({ code: code, redeemedBy: null }, { redeemedBy: socket.user.username }, { new: true });
            if (!gc) return socket.emit('promoResult', { success: false, msg: 'Invalid or already used' });
            const user = await User.findById(socket.user._id);
            if(gc.creditType === 'playable') { user.playableCredits = formatTC((user.playableCredits || 0) + gc.amount); } 
            else { user.credits = formatTC((user.credits || 0) + gc.amount); }
            await user.save();
            await new CreditLog({ username: user.username, action: 'CODE', amount: gc.amount, details: `Redeemed` }).save();
            sendPulse(`${socket.user.username} redeemed Promo Code for ${gc.amount}.`, 'success');
            pushAdminData();
            socket.emit('promoResult', { success: true, amt: gc.amount, type: gc.creditType });
            socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
        } catch(e) { socket.emit('promoResult', { success: false, msg: 'Server error' }); }
    });

    socket.on('adminAction', async (data) => {
        if (!socket.rooms.has('admin_room')) return; 
        try {
            const adminName = socket.user ? socket.user.username : 'System';

            if (data.type === 'toggleMaintenance') {
                isMaintenanceMode = !isMaintenanceMode;
                io.emit('maintenanceToggle', isMaintenanceMode);
                sendPulse(`Maintenance Mode is now ${isMaintenanceMode ? 'ON' : 'OFF'}`, 'alert');
                socket.emit('adminSuccess', `Maintenance Mode: ${isMaintenanceMode ? 'ACTIVE' : 'DISABLED'}`);
            }
            else if (data.type === 'editUser') { 
                let u = await User.findById(data.id);
                if (u) {
                    u.credits = formatTC(data.credits);
                    u.playableCredits = formatTC(data.playableCredits);
                    u.role = data.role;
                    await u.save();
                    
                    await new AdminLog({ adminName, action: 'EDIT USER', details: `Updated balances for ${u.username}` }).save();
                    sendPulse(`${adminName} edited balances for ${u.username}`, 'info');
                    
                    let targetSocketId = connectedUsers[u.username];
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                        io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: 'Balance Updated', msg: 'An admin has manually adjusted your account balance.', date: new Date() });
                    }
                    socket.emit('adminSuccess', `Successfully updated ${u.username}.`);
                }
            }
            else if (data.type === 'ban') { 
                let u = await User.findById(data.id);
                if(u) { u.status = 'Banned'; await u.save(); await new AdminLog({ adminName, action: 'BAN', details: `Banned user ${u.username}` }).save(); sendPulse(`${adminName} BANNED ${u.username}`, 'alert'); socket.emit('adminSuccess', `Banned ${u.username}.`); }
            }
            else if (data.type === 'unban') { 
                let u = await User.findById(data.id);
                if(u) { u.status = 'Active'; await u.save(); await new AdminLog({ adminName, action: 'UNBAN', details: `Unbanned user ${u.username}` }).save(); sendPulse(`${adminName} UNBANNED ${u.username}`, 'success'); socket.emit('adminSuccess', `Unbanned ${u.username}.`); }
            }
            else if (data.type === 'clearUserLogs') {
                await CreditLog.deleteMany({ username: data.username });
                const logs = await CreditLog.find({ username: data.username }).sort({ date: -1 }).limit(100);
                socket.emit('userLogsData', { username: data.username, logs });
                await new AdminLog({ adminName, action: 'CLEAR LOGS', details: `Cleared logs for ${data.username}` }).save();
                sendPulse(`${adminName} cleared logs for ${data.username}`, 'info');
                socket.emit('adminSuccess', `Cleared logs for ${data.username}.`);
            }
            else if (data.type === 'sendUpdate') { 
                io.emit('silentNotification', { id: Date.now(), title: 'System Announcement', msg: data.msg, date: new Date() }); 
                await new AdminLog({ adminName, action: 'BROADCAST', details: `Msg: ${data.msg}` }).save();
                sendPulse(`${adminName} sent Global Broadcast.`, 'info');
                socket.emit('adminSuccess', `Broadcast sent successfully.`);
            }
            else if (data.type === 'giftCredits') {
                let amount = formatTC(data.amount);
                let updateQuery = data.creditType === 'playable' ? { $inc: { playableCredits: amount } } : { $inc: { credits: amount } };
                let notifMsg = `Admin has gifted you ${amount} ${data.creditType === 'playable' ? 'Playable P' : 'TC'}!`;

                if (data.target === 'all_registered') {
                    await User.updateMany({}, updateQuery);
                    io.emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                    io.emit('forceBalanceRefresh'); 
                    await new AdminLog({ adminName, action: 'GIFT', details: `Mass gifted ${amount} to All Registered` }).save();
                    sendPulse(`${adminName} mass gifted ${amount} to All Registered`, 'success');
                    socket.emit('adminSuccess', `Mass gift sent to All Registered users.`);
                } 
                else if (data.target === 'all_active') {
                    await User.updateMany({ status: 'Active' }, updateQuery);
                    io.emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                    io.emit('forceBalanceRefresh');
                    await new AdminLog({ adminName, action: 'GIFT', details: `Mass gifted ${amount} to All Active` }).save();
                    sendPulse(`${adminName} mass gifted ${amount} to All Active`, 'success');
                    socket.emit('adminSuccess', `Mass gift sent to All Active users.`);
                } 
                else {
                    let u = await User.findOne({ username: new RegExp('^' + data.target + '$', 'i') });
                    if (u) {
                        if(data.creditType === 'playable') u.playableCredits = formatTC((u.playableCredits || 0) + amount);
                        else u.credits = formatTC((u.credits || 0) + amount);
                        await u.save();
                        await new CreditLog({ username: u.username, action: 'GIFT', amount: amount, details: `From Admin` }).save();
                        await new AdminLog({ adminName, action: 'GIFT', details: `Gifted ${amount} to ${u.username}` }).save();
                        sendPulse(`${adminName} gifted ${amount} to ${u.username}`, 'success');
                        
                        let targetSocketId = connectedUsers[u.username];
                        if (targetSocketId) {
                            io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: 'Gift Received!', msg: notifMsg, date: new Date() });
                            io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                        }
                        socket.emit('adminSuccess', `Gift sent to ${u.username}.`);
                    } else {
                        socket.emit('adminError', `User ${data.target} not found.`);
                    }
                }
            }
            else if (data.type === 'resolveTx') {
                let tx = await Transaction.findById(data.id);
                if (tx && tx.status === 'Pending') {
                    tx.status = data.status; await tx.save();
                    
                    await new AdminLog({ adminName, action: 'RESOLVE TX', details: `Marked ${tx.type} for ${tx.username} as ${data.status}` }).save();
                    sendPulse(`${adminName} ${data.status.toUpperCase()} ${tx.type} for ${tx.username}`, data.status === 'Approved' ? 'success' : 'alert');

                    let targetSocketId = connectedUsers[tx.username];
                    if (tx.type === 'Deposit' && data.status === 'Approved') {
                        let u = await User.findOne({ username: tx.username });
                        if (u) {
                            u.credits = formatTC((u.credits || 0) + tx.amount); await u.save();
                            await new CreditLog({ username: u.username, action: 'DEPOSIT', amount: tx.amount, details: `Approved` }).save();
                            
                            // 10% First Deposit Referral Bonus
                            let depCount = await Transaction.countDocuments({ username: tx.username, type: 'Deposit', status: 'Approved' });
                            if (depCount === 1 && u.referredBy) { 
                                let referrer = await User.findOne({ username: u.referredBy });
                                if (referrer) {
                                    let bonus = formatTC(tx.amount * 0.10);
                                    referrer.playableCredits = formatTC((referrer.playableCredits || 0) + bonus);
                                    await referrer.save();
                                    await new CreditLog({ username: referrer.username, action: 'REFERRAL', amount: bonus, details: `10% Dep Bonus (${u.username})` }).save();
                                    
                                    let refSock = connectedUsers[referrer.username];
                                    if (refSock) {
                                        io.to(refSock).emit('balanceUpdateData', { credits: referrer.credits, playable: referrer.playableCredits });
                                        io.to(refSock).emit('silentNotification', { id: Date.now(), title: 'Referral Deposit Bonus!', msg: `${u.username} made their first deposit! +${bonus} P`, date: new Date() });
                                    }
                                }
                            }

                            if (targetSocketId) {
                                io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: 'Deposit Approved', msg: `Your deposit of ${tx.amount} TC has been added to your balance.`, date: new Date() });
                                io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                            }
                        }
                    }
                    else if (data.status === 'Rejected') {
                        if (tx.type === 'Withdrawal') {
                            let u = await User.findOne({ username: tx.username });
                            if (u) { 
                                u.credits = formatTC((u.credits || 0) + tx.amount); await u.save(); 
                                await new CreditLog({ username: u.username, action: 'REFUND', amount: tx.amount, details: `Withdrawal Rejected` }).save();
                                if (targetSocketId) io.to(targetSocketId).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits }); 
                            }
                        }
                        if (targetSocketId) { io.to(targetSocketId).emit('silentNotification', { id: Date.now(), title: `${tx.type} Rejected`, msg: `Your request was rejected.`, date: new Date() }); }
                    }
                    socket.emit('adminSuccess', `Transaction marked as ${data.status}.`);
                }
            }
            else if (data.type === 'createBatch') {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                let prefix = data.creditType === 'playable' ? 'PB-' : 'RB-';
                let existingBatches = await GiftCode.find({ batchId: new RegExp('^' + prefix) }).distinct('batchId');
                let nextNum = existingBatches.length + 1;
                let batchId = prefix + String(nextNum).padStart(3, '0');
                
                for(let i=0; i<data.count; i++) {
                    let code = '';
                    for(let j=0; j<10; j++) code += chars.charAt(crypto.randomInt(chars.length));
                    await new GiftCode({ batchId, amount: formatTC(data.amount), code, creditType: data.creditType }).save();
                }
                await new AdminLog({ adminName, action: 'CREATE BATCH', details: `Created batch ${batchId} (${data.count} codes)` }).save();
                sendPulse(`${adminName} generated batch ${batchId}`, 'info');
                socket.emit('adminSuccess', `Batch ${batchId} created successfully.`);
            }
            else if (data.type === 'deleteBatch') { 
                await GiftCode.deleteMany({ batchId: data.batchId }); 
                await new AdminLog({ adminName, action: 'DELETE BATCH', details: `Deleted batch ${data.batchId}` }).save();
                sendPulse(`${adminName} deleted batch ${data.batchId}`, 'alert');
                socket.emit('adminSuccess', `Batch ${data.batchId} deleted.`);
            }
            await pushAdminData();
        } catch(e) { console.error("Admin Action Error:", e); socket.emit('adminError', "Server Error: " + e.message); }
    });

    socket.on('getGlobalResults', (game) => {
        socket.emit('globalResultsData', { game: game, results: globalResults[game] || [], stats: gameStats[game] || { total: 0 } });
    });

    socket.on('disconnect', async () => {
        if (socket.user) { 
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); 
            delete connectedUsers[socket.user.username];
            
            for(let s in mbjState.seats) {
                if (mbjState.seats[s] && mbjState.seats[s].userId.toString() === socket.user._id.toString()) {
                    if (mbjState.seats[s].bet === 0) {
                        mbjState.seats[s] = null;
                        io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats });
                    }
                }
            }
        }
        if(socket.currentRoom && rooms[socket.currentRoom] > 0) {
            rooms[socket.currentRoom]--; io.emit('playerCount', rooms);
        }
        pushAdminData();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
