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

    let fromPlayable = 0, fromMain = 0;
    if ((user.playableCredits || 0) >= amt) {
        fromPlayable = amt; user.playableCredits = formatTC(user.playableCredits - amt);
    } else {
        fromPlayable = user.playableCredits || 0; fromMain = formatTC(amt - fromPlayable);
        user.playableCredits = 0; user.credits = formatTC((user.credits || 0) - fromMain);
    }
    return { success: true, fromPlayable, fromMain };
}

function sendPulse(msg, type='info') { io.to('admin_room').emit('adminPulse', { msg, type, time: Date.now() }); }

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
            if (refSock) io.to(refSock).emit('balanceUpdateData', { credits: referrer.credits, playable: referrer.playableCredits });
        }
    } catch(e) {}
}

const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI).then(async () => {
    const adminExists = await User.findOne({ username: 'admin' });
    if (!adminExists) await new User({ username: 'admin', password: 'Kenm44ashley', role: 'Admin', credits: 10000, playableCredits: 0 }).save();
    pushAdminData();
}).catch(err => console.error('MongoDB Error:', err));

const userSchema = new mongoose.Schema({ username: { type: String, required: true, unique: true }, password: { type: String, required: true }, role: { type: String, default: 'Player' }, credits: { type: Number, default: 0 }, playableCredits: { type: Number, default: 0 }, status: { type: String, default: 'Offline' }, ipAddress: { type: String, default: 'Unknown' }, joinDate: { type: Date, default: Date.now }, referredBy: { type: String, default: null }, dailyReward: { lastClaim: { type: Date, default: null }, streak: { type: Number, default: 0 } } });
const User = mongoose.model('User', userSchema);
const txSchema = new mongoose.Schema({ username: String, type: String, amount: Number, ref: String, status: { type: String, default: 'Pending' }, date: { type: Date, default: Date.now } });
const Transaction = mongoose.model('Transaction', txSchema);
const codeSchema = new mongoose.Schema({ batchId: String, amount: Number, code: String, creditType: { type: String, default: 'playable' }, redeemedBy: { type: String, default: null }, date: { type: Date, default: Date.now } });
const GiftCode = mongoose.model('GiftCode', codeSchema);
const creditLogSchema = new mongoose.Schema({ username: String, action: String, amount: Number, details: String, date: { type: Date, default: Date.now } });
const CreditLog = mongoose.model('CreditLog', creditLogSchema);
const adminLogSchema = new mongoose.Schema({ adminName: String, action: String, details: String, date: { type: Date, default: Date.now } });
const AdminLog = mongoose.model('AdminLog', adminLogSchema);

let rooms = { baccarat: 0, perya: 0, dt: 0, sicbo: 0, mbj: 0 };
let connectedUsers = {}; 
let globalResults = { baccarat: [], perya: [], dt: [], sicbo: [] }; 

let sharedTables = {
    baccarat: { time: 15, maxTime: 15, status: 'BETTING', bets: [] },
    perya: { time: 15, maxTime: 15, status: 'BETTING', bets: [] },
    dt: { time: 10, maxTime: 10, status: 'BETTING', bets: [] },
    sicbo: { time: 10, maxTime: 10, status: 'BETTING', bets: [] }
};

let gameStats = {
    baccarat: { total: 0, Player: 0, Banker: 0, Tie: 0 }, dt: { total: 0, Dragon: 0, Tiger: 0, Tie: 0 },
    sicbo: { total: 0, Big: 0, Small: 0, Triple: 0 }, perya: { total: 0, Yellow: 0, White: 0, Pink: 0, Blue: 0, Red: 0, Green: 0 },
    coinflip: { total: 0, Heads: 0, Tails: 0 }, d20: { total: 0, Win: 0, Lose: 0 }, blackjack: { total: 0, Win: 0, Lose: 0, Push: 0 }
};

function logGlobalResult(game, resultStr) { if(globalResults[game]) { globalResults[game].unshift({ result: resultStr, time: new Date() }); if (globalResults[game].length > 5) globalResults[game].pop(); } }
function checkResetStats(game) { if (gameStats[game].total >= 100) { Object.keys(gameStats[game]).forEach(key => { gameStats[game][key] = 0; }); } }

function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']; const ss = ['♠','♣','♥','♦'];
    let v = vs[crypto.randomInt(vs.length)], s = ss[crypto.randomInt(ss.length)];
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v);
    let dt = (v === 'A') ? 1 : (v === 'K' ? 13 : (v === 'Q' ? 12 : (v === 'J' ? 11 : parseInt(v))));
    let suitHtml = (s === '♥' || s === '♦') ? `<span class="card-red">${s}</span>` : s;
    return { val: v, suit: s, bacVal: bac, bjVal: bj, dtVal: dt, raw: v, suitHtml: suitHtml };
}

async function resolveSharedRoom(room, table) {
    let resData = {}, winnerStr = '', resStr = '', playerStats = {};

    if (room === 'dt') {
        let dtD = drawCard(), dtT = drawCard();
        winnerStr = dtD.dtVal > dtT.dtVal ? 'Dragon' : (dtT.dtVal > dtD.dtVal ? 'Tiger' : 'Tie');
        resStr = winnerStr === 'Tie' ? `TIE (${dtD.raw} TO ${dtT.raw})` : `${winnerStr.toUpperCase()} (${dtD.raw} TO ${dtT.raw})`;
        resData = { room: 'dt', dCard: dtD, tCard: dtT, winner: winnerStr, resStr };
    } else if (room === 'sicbo') {
        let sbR = [crypto.randomInt(1, 7), crypto.randomInt(1, 7), crypto.randomInt(1, 7)];
        let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
        winnerStr = sbTrip ? 'Triple' : ((sbR[0]+sbR[1]+sbR[2]) <= 10 ? 'Small' : 'Big');
        resStr = sbTrip ? `TRIPLE (${sbR[0]})` : `${winnerStr.toUpperCase()}`;
        resData = { room: 'sicbo', roll: sbR, sum: sbR[0]+sbR[1]+sbR[2], winner: winnerStr, resStr };
    } else if (room === 'perya') {
        const cols = ['Yellow','White','Pink','Blue','Red','Green'];
        let pyR = [cols[crypto.randomInt(6)], cols[crypto.randomInt(6)], cols[crypto.randomInt(6)]];
        resData = { room: 'perya', roll: pyR, resStr: pyR.join(',') };
    } else if (room === 'baccarat') {
        let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
        let pS = (pC[0].bacVal + pC[1].bacVal) % 10, bS = (bC[0].bacVal + bC[1].bacVal) % 10;
        let p3Drawn = false, b3Drawn = false;
        if (pS < 8 && bS < 8) {
            let p3Val = -1;
            if (pS <= 5) { pC.push(drawCard()); p3Val = pC[2].bacVal; pS = (pS + p3Val) % 10; p3Drawn = true; }
            let bDraws = false;
            if (pC.length === 2) { if (bS <= 5) bDraws = true; } else {
                if (bS <= 2) bDraws = true; else if (bS === 3 && p3Val !== 8) bDraws = true; else if (bS === 4 && p3Val >= 2 && p3Val <= 7) bDraws = true; else if (bS === 5 && p3Val >= 4 && p3Val <= 7) bDraws = true; else if (bS === 6 && (p3Val === 6 || p3Val === 7)) bDraws = true;
            }
            if (bDraws) { bC.push(drawCard()); bS = (bS + bC[bC.length-1].bacVal) % 10; b3Drawn = true; }
        }
        winnerStr = pS > bS ? 'Player' : (bS > pS ? 'Banker' : 'Tie');
        resStr = winnerStr === 'Tie' ? `TIE (${pS} TO ${bS})` : `${winnerStr.toUpperCase()} (${pS} TO ${bS})`;
        resData = { room: 'baccarat', pCards: pC, bCards: bC, pScore: pS, bScore: bS, winner: winnerStr, resStr, p3Drawn, b3Drawn };
    }

    table.bets.forEach(b => {
        let payout = 0;
        if (room === 'dt') { if (winnerStr === 'Tie') payout = b.choice === 'Tie' ? b.amount * 9 : b.amount; else if (b.choice === winnerStr) payout = b.amount * 2; } 
        else if (room === 'sicbo') { if (b.choice === winnerStr) payout = b.amount * 2; } 
        else if (room === 'perya') { let m = resData.roll.filter(c => c === b.choice).length; if (m > 0) payout = b.amount + (b.amount * m); } 
        else if (room === 'baccarat') {
            if (winnerStr === 'Tie') payout = b.choice === 'Tie' ? b.amount * 9 : (b.choice === 'Player' || b.choice === 'Banker' ? b.amount : 0);
            else if (winnerStr === 'Player' && b.choice === 'Player') payout = b.amount * 2;
            else if (winnerStr === 'Banker' && b.choice === 'Banker') payout = b.amount * 1.95;
        }
        if (!playerStats[b.userId]) playerStats[b.userId] = { socketId: b.socketId, username: b.username, amountWon: 0, amountBet: 0 };
        playerStats[b.userId].amountBet += b.amount; playerStats[b.userId].amountWon += formatTC(payout);
    });

    let roomNames = { 'perya': 'Color Game', 'dt': 'Dragon Tiger', 'sicbo': 'Sic Bo', 'baccarat': 'Baccarat' };
    Object.keys(playerStats).forEach(async (userId) => {
        let st = playerStats[userId], user = await User.findById(userId);
        if (user) {
            if (st.amountWon > 0) { user.credits = formatTC((user.credits || 0) + st.amountWon); await user.save(); }
            let net = formatTC(st.amountWon - st.amountBet);
            if (net !== 0) await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: roomNames[room] }).save();
        }
    });

    io.to(room).emit('sharedResults', resData);
    setTimeout(() => { logGlobalResult(room, resStr); gameStats[room].total++; if(room === 'perya') resData.roll.forEach(c => gameStats.perya[c]++); else gameStats[room][winnerStr]++; checkResetStats(room); }, 2500);
}

setInterval(() => {
    Object.keys(sharedTables).forEach(room => {
        let table = sharedTables[room];
        if (table.status === 'BETTING') {
            table.time--; io.to(room).emit('timerUpdate', table.time);
            if (table.time <= 0) {
                table.status = 'RESOLVING'; io.to(room).emit('lockBets');
                setTimeout(async () => { await resolveSharedRoom(room, table); }, 500);
                setTimeout(() => { table.time = table.maxTime; table.status = 'BETTING'; table.bets = []; io.to(room).emit('newRound'); pushAdminData(); }, 9000); 
            }
        }
    });
}, 1000);

async function pushAdminData(targetSocket = null) {
    try {
        const users = await User.find(); const txs = await Transaction.find().sort({ date: -1 }); const gcs = await GiftCode.find().sort({ date: -1 });
        let totalMainCredits = formatTC(users.reduce((a, b) => a + (b.credits || 0), 0)); 
        let approvedDeposits = txs.filter(t => t.type === 'Deposit' && t.status === 'Approved').reduce((a, b) => a + b.amount, 0);
        let approvedWithdrawals = txs.filter(t => t.type === 'Withdrawal' && t.status === 'Approved').reduce((a, b) => a + b.amount, 0);
        globalBankVault = formatTC(2000000 + approvedDeposits - approvedWithdrawals - totalMainCredits);
        const gameLogs = await CreditLog.find({ action: 'GAME', date: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
        let houseProfit24h = formatTC(-gameLogs.reduce((sum, l) => sum + l.amount, 0));
        let payload = { users, transactions: txs, giftBatches: gcs, adminLogs: await AdminLog.find().sort({ date: -1 }).limit(100), stats: { economy: totalMainCredits, approvedDeposits: formatTC(approvedDeposits), limit: globalBankVault, houseProfit: houseProfit24h }, isMaintenance: isMaintenanceMode };
        if(targetSocket) { targetSocket.emit('adminDataSync', payload); } else { io.to('admin_room').emit('adminDataSync', payload); }
    } catch(e) {}
}

io.on('connection', (socket) => {
    socket.emit('maintenanceToggle', isMaintenanceMode); socket.emit('radioSync', currentRadio); 
    socket.isBetting = false; socket.isSharedBetting = false; socket.isCashier = false; socket.isAuth = false;

    socket.on('voiceStream', (data) => { if (socket.currentRoom) socket.to(socket.currentRoom).emit('voiceStream', data); });
    socket.on('requestBalanceRefresh', async () => { if(socket.user) { let u = await User.findById(socket.user._id); if(u) socket.emit('balanceUpdateData', { credits: formatTC(u.credits), playable: formatTC(u.playableCredits) }); } });
    
    socket.on('getWalletLogs', async () => {
        if(socket.user) {
            const logs = await CreditLog.find({ username: socket.user.username }).sort({ date: -1 }).limit(50);
            const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
            const todayLogs = await CreditLog.find({ username: socket.user.username, date: { $gte: startOfDay }});
            let dailyProfit = 0; todayLogs.forEach(l => { if (l.action === 'GAME') dailyProfit += l.amount; });
            socket.emit('walletLogsData', { logs, dailyProfit: formatTC(dailyProfit) });
        }
    });

    socket.on('clearWalletLogs', async () => { if(socket.user) { await CreditLog.deleteMany({ username: socket.user.username }); socket.emit('walletLogsData', { logs: [], dailyProfit: 0 }); } });
    socket.on('fetchUserLogs', async (username) => { if (socket.rooms.has('admin_room')) { const logs = await CreditLog.find({ username }).sort({ date: -1 }).limit(100); socket.emit('userLogsData', { username, logs }); } });

    socket.on('playSolo', async (data) => {
        if (isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.game });
        if (!socket.user || socket.isBetting) return; socket.isBetting = true;
        try {
            const user = await User.findById(socket.user._id); if (!user) return;
            let isNewBet = (data.game === 'd20' || data.game === 'coinflip' || (data.game === 'blackjack' && data.action === 'start'));
            let amt = formatTC(data.bet || 0);

            if (isNewBet) {
                if (data.game === 'd20' || data.game === 'coinflip' || data.game === 'blackjack') {
                    if (isNaN(amt) || amt < 10) return socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.game });
                    if (amt > 50000) return socket.emit('localGameError', { msg: 'MAX TOTAL BET IS 50K TC', game: data.game });
                }
                
                let deduction = await deductBet(user, amt);
                if (!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.game });
                await user.save();
                
                if (data.game === 'blackjack') {
                    socket.bjState = { bet: amt, pHand: [drawCard(), drawCard()], dHand: [drawCard(), drawCard()], fromPlayable: deduction.fromPlayable, fromMain: deduction.fromMain };
                }
            }

            let payout = 0;
            if (data.game === 'd20') {
                let roll = crypto.randomInt(1, 21); let isEven = roll % 2 === 0;
                if ((data.choice === 'Even' && isEven) || (data.choice === 'Odd' && !isEven)) payout = formatTC(data.bet * 1.95);
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `D20` }).save();
                socket.emit('d20Result', { roll, payout, bet: data.bet, resStr: `ROLLED ${roll}`, newBalance: { credits: user.credits, playable: user.playableCredits }});
                setTimeout(() => { gameStats.d20.total++; if(payout > 0) gameStats.d20.Win++; else gameStats.d20.Lose++; checkResetStats('d20'); }, 1500);
            } 
            else if (data.game === 'coinflip') {
                let result = crypto.randomInt(2) === 0 ? 'Heads' : 'Tails';
                if (data.choice === result) payout = formatTC(data.bet * 1.95);
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `Coin Flip` }).save();
                socket.emit('coinResult', { result, payout, bet: data.bet, resStr: result.toUpperCase(), newBalance: { credits: user.credits, playable: user.playableCredits }});
                setTimeout(() => { gameStats.coinflip.total++; gameStats.coinflip[result]++; checkResetStats('coinflip'); }, 1500);
            }
            else if (data.game === 'blackjack') {
                if (data.action === 'start') {
                    let pS = getBJScore(socket.bjState.pHand); let dS = getBJScore(socket.bjState.dHand);
                    if (pS === 21) {
                        let msg = dS === 21 ? 'Push' : 'Blackjack'; payout = formatTC(dS === 21 ? socket.bjState.bet : socket.bjState.bet * 2.5);
                        if (msg === 'Push') { user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable); user.credits = formatTC(user.credits + socket.bjState.fromMain); } else { user.credits = formatTC(user.credits + payout); }
                        await user.save(); await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                        socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, naturalBJ: true, payout, msg, resStr: `${msg.toUpperCase()} (${pS} TO ${dS})`, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits }});
                        socket.bjState = null; setTimeout(() => { gameStats.blackjack.total++; if(msg === 'Blackjack') gameStats.blackjack.Win++; else gameStats.blackjack.Push++; checkResetStats('blackjack'); }, 1500);
                    } else { socket.emit('bjUpdate', { event: 'deal', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand }); }
                }
                else if (data.action === 'hit') {
                    if(!socket.bjState) return;
                    socket.bjState.pHand.push(drawCard()); let pS = getBJScore(socket.bjState.pHand);
                    if (pS > 21) {
                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(-socket.bjState.bet), details: `Blackjack` }).save();
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust', resStr: `PLAYER BUSTS!`, bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                        socket.bjState = null; setTimeout(() => { gameStats.blackjack.total++; gameStats.blackjack.Lose++; checkResetStats('blackjack'); }, 1500);
                    } else if (pS === 21) {
                        while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                        let dS = getBJScore(socket.bjState.dHand); let msg = '';
                        if (dS > 21 || pS > dS) { payout = formatTC(socket.bjState.bet * 2); msg = 'You Win'; } else if (pS === dS) { payout = formatTC(socket.bjState.bet); msg = 'Push'; } else { msg = 'Dealer Wins'; }
                        if (msg === 'Push') { user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable); user.credits = formatTC(user.credits + socket.bjState.fromMain); } else { user.credits = formatTC(user.credits + payout); }
                        await user.save(); await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr: (dS > 21) ? `DEALER BUSTS!` : (msg === 'Push' ? `TIE (${dS} TO ${pS})` : (msg === 'You Win' ? `PLAYER (${dS} TO ${pS})` : `DEALER (${dS} TO ${pS})`)), bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                        socket.bjState = null; setTimeout(() => { gameStats.blackjack.total++; if (dS > 21 || pS > dS) gameStats.blackjack.Win++; else if (pS === dS) gameStats.blackjack.Push++; else gameStats.blackjack.Lose++; checkResetStats('blackjack'); }, 1500);
                    } else { socket.emit('bjUpdate', { event: 'hit', pHand: socket.bjState.pHand }); }
                }
                else if (data.action === 'double') {
                    if(!socket.bjState || socket.bjState.pHand.length !== 2) return;
                    let deduction = await deductBet(user, socket.bjState.bet);
                    if (!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: 'blackjack' });
                    await user.save(); socket.bjState.fromPlayable += deduction.fromPlayable; socket.bjState.fromMain += deduction.fromMain; socket.bjState.bet *= 2; 
                    socket.bjState.pHand.push(drawCard()); let pS = getBJScore(socket.bjState.pHand);
                    if (pS > 21) {
                        await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(-socket.bjState.bet), details: `Blackjack` }).save();
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout: 0, msg: 'Bust', resStr: 'PLAYER BUSTS!', bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                        socket.bjState = null; setTimeout(() => { gameStats.blackjack.total++; gameStats.blackjack.Lose++; checkResetStats('blackjack'); }, 1500);
                    } else {
                        while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                        let dS = getBJScore(socket.bjState.dHand); let msg = '';
                        if (dS > 21 || pS > dS) { payout = formatTC(socket.bjState.bet * 2); msg = 'You Win'; } else if (pS === dS) { payout = formatTC(socket.bjState.bet); msg = 'Push'; } else { msg = 'Dealer Wins'; }
                        if (msg === 'Push') { user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable); user.credits = formatTC(user.credits + socket.bjState.fromMain); } else { user.credits = formatTC(user.credits + payout); }
                        await user.save(); await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                        socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr: (dS > 21) ? `DEALER BUSTS!` : (msg === 'Push' ? `TIE (${dS} TO ${pS})` : (msg === 'You Win' ? `PLAYER (${dS} TO ${pS})` : `DEALER (${dS} TO ${pS})`)), bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                        socket.bjState = null; setTimeout(() => { gameStats.blackjack.total++; if (dS > 21 || pS > dS) gameStats.blackjack.Win++; else if (pS === dS) gameStats.blackjack.Push++; else gameStats.blackjack.Lose++; checkResetStats('blackjack'); }, 1500);
                    }
                }
                else if (data.action === 'stand') {
                    if(!socket.bjState) return;
                    let pS = getBJScore(socket.bjState.pHand);
                    while (getBJScore(socket.bjState.dHand) < 17) { socket.bjState.dHand.push(drawCard()); }
                    let dS = getBJScore(socket.bjState.dHand); let msg = '';
                    if (dS > 21 || pS > dS) { payout = formatTC(socket.bjState.bet * 2); msg = 'You Win'; } else if (pS === dS) { payout = formatTC(socket.bjState.bet); msg = 'Push'; } else { msg = 'Dealer Wins'; }
                    if (msg === 'Push') { user.playableCredits = formatTC(user.playableCredits + socket.bjState.fromPlayable); user.credits = formatTC(user.credits + socket.bjState.fromMain); } else { user.credits = formatTC(user.credits + payout); }
                    await user.save(); await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - socket.bjState.bet), details: `Blackjack` }).save();
                    socket.emit('bjUpdate', { event: 'resolved', pHand: socket.bjState.pHand, dHand: socket.bjState.dHand, payout, msg, resStr: (dS > 21) ? `DEALER BUSTS!` : (msg === 'Push' ? `TIE (${dS} TO ${pS})` : (msg === 'You Win' ? `PLAYER (${dS} TO ${pS})` : `DEALER (${dS} TO ${pS})`)), bet: socket.bjState.bet, newBalance: { credits: user.credits, playable: user.playableCredits } });
                    socket.bjState = null; setTimeout(() => { gameStats.blackjack.total++; if (dS > 21 || pS > dS) gameStats.blackjack.Win++; else if (pS === dS) gameStats.blackjack.Push++; else gameStats.blackjack.Lose++; checkResetStats('blackjack'); }, 1500);
                }
            }
        } finally { socket.isBetting = false; }
    });

    socket.on('joinRoom', (room) => { 
        if(socket.currentRoom) { socket.leave(socket.currentRoom); rooms[socket.currentRoom]--; }
        socket.join(room); socket.currentRoom = room; rooms[room]++; io.emit('playerCount', rooms); 
        if (room === 'mbj') {
            socket.emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, active: Object.values(mbjState.seats).some(s => s && s.hands.length > 0 && s.hands[0].bet > 0) });
            if (mbjState.status === 'PLAYER_TURN') socket.emit('mbjUpdate', { event: 'turn', activeTurn: mbjState.activeTurn, time: mbjState.turnTimer, seats: mbjState.seats });
        } else {
            if(sharedTables[room]) socket.emit('timerUpdate', sharedTables[room].time);
        }
    });
    
    socket.on('leaveRoom', (room) => { 
        if (socket.currentRoom === 'mbj') {
            for(let i = 1; i <= 5; i++) {
                let s = mbjState.seats[i];
                if (s && s.userId.toString() === socket.user._id.toString() && mbjState.status === 'BETTING') {
                    mbjState.seats[i] = null;
                    io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, active: Object.values(mbjState.seats).some(st => st && st.hands.length > 0 && st.hands[0].bet > 0) });
                    break;
                }
            }
        }
        socket.leave(room); socket.currentRoom = null; if (rooms[room] > 0) rooms[room]--; io.emit('playerCount', rooms); 
    });
    
    socket.on('sendChat', (data) => { 
        if (!socket.user) return;
        if (data.msg.startsWith('/play ')) {
            if (socket.user.role !== 'Admin' && socket.user.role !== 'VIP') return;
            let url = data.msg.replace('/play ', '').trim(); currentRadio = { url, startTime: Date.now(), requestedBy: socket.user.username };
            io.emit('radioPlay', currentRadio); io.emit('globalChatMessage', { sys: true, text: `🎵 [RADIO] ${socket.user.username} started playing a track!` }); return;
        }
        if (data.msg === '/stop') {
            if (socket.user.role !== 'Admin' && socket.user.role !== 'VIP') return;
            currentRadio = { url: null, startTime: 0, requestedBy: null }; io.emit('radioStop'); io.emit('globalChatMessage', { sys: true, text: `🎵 [RADIO] DJ turned off by ${socket.user.username}.` }); return;
        }
        if (socket.currentRoom) { socket.broadcast.to(socket.currentRoom).emit('chatMessage', { user: socket.user.username, text: data.msg, sys: false }); } 
    });
    
    socket.on('getRoomPlayers', (room) => {
        let playersInRoom = [];
        for (let username in connectedUsers) {
            let s = io.sockets.sockets.get(connectedUsers[username]);
            if (s && s.rooms.has(room)) playersInRoom.push(username);
        }
        socket.emit('roomPlayersList', playersInRoom);
    });
    
    socket.on('placeSharedBet', async (data) => {
        if (isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.room });
        if (!socket.user) return;
        let table = sharedTables[data.room];
        if (!table || table.status !== 'BETTING' || table.time <= 0) return socket.emit('localGameError', { msg: 'BETS ARE CLOSED FOR THIS ROUND', game: data.room });
        if (socket.isSharedBetting) return; socket.isSharedBetting = true;
        try {
            const user = await User.findById(socket.user._id); if (!user) return;
            let amt = formatTC(data.amount); if (isNaN(amt) || amt < 10) return socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.room });
            let currentTileBet = table.bets.filter(b => b.userId.toString() === user._id.toString() && b.choice === data.choice).reduce((sum, b) => sum + b.amount, 0);
            if (currentTileBet + amt > 50000) return socket.emit('localGameError', { msg: 'MAX 50K TC PER TILE', game: data.room });
            let deduction = await deductBet(user, amt);
            if (!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.room });
            await user.save();
            table.bets.push({ userId: user._id, socketId: socket.id, username: user.username, room: data.room, choice: data.choice, amount: amt, fromPlayable: deduction.fromPlayable, fromMain: deduction.fromMain });
            socket.emit('sharedBetConfirmed', { choice: data.choice, amount: amt, room: data.room, newBalance: { credits: user.credits, playable: user.playableCredits } });
        } finally { socket.isSharedBetting = false; }
    });

    socket.on('undoSharedBet', async (data) => {
        let table = sharedTables[data.room];
        if (!socket.user || !table || table.status !== 'BETTING' || table.time <= 0) return;
        if (socket.isSharedBetting) return; socket.isSharedBetting = true;
        try {
            for (let i = table.bets.length - 1; i >= 0; i--) {
                let b = table.bets[i];
                if (b.userId.toString() === socket.user._id.toString()) {
                    let user = await User.findById(socket.user._id);
                    if (user) {
                        user.playableCredits = formatTC((user.playableCredits || 0) + b.fromPlayable); user.credits = formatTC((user.credits || 0) + b.fromMain);
                        await user.save(); socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits }); socket.emit('undoSuccess', { choice: b.choice, amount: b.amount, newBalance: { credits: user.credits, playable: user.playableCredits } });
                    }
                    table.bets.splice(i, 1); break;
                }
            }
        } finally { socket.isSharedBetting = false; }
    });

    socket.on('submitTransaction', async (data) => { 
        if (!socket.user || socket.isCashier) return; socket.isCashier = true;
        try {
            let amount = formatTC(data.amount); if(isNaN(amount) || amount <= 0) return;
            if(data.type === 'Withdrawal') {
                const user = await User.findOneAndUpdate({ _id: socket.user._id, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
                if (!user) return socket.emit('localGameError', { msg: 'Insufficient TC.', game: 'cashier' });
                socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits });
            }
            await new Transaction({ username: socket.user.username, type: data.type, amount: amount, ref: data.ref || 'Cashier' }).save(); 
            socket.emit('transactionsData', await Transaction.find({ username: socket.user.username }).sort({ date: -1 }));
        } finally { socket.isCashier = false; }
    });

    socket.on('adminLogin', async (data) => { /* Admin logic unchanged... */ });
    socket.on('adminAction', async (data) => { /* Admin logic unchanged... */ });

    // --- VIP BLACKJACK ENGINE ---
    let mbjGlobalShoe = mbjBuildShoe(6);
    function mbjBuildShoe(decks = 6) { let shoe = []; const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']; const ss = ['♠','♣','♥','♦']; for(let d = 0; d < decks; d++) { for(let s of ss) { for(let v of vs) { let bj = isNaN(parseInt(v)) ? (v === 'A' ? 11 : 10) : parseInt(v); let colorClass = (s === '♥' || s === '♦') ? `card-red` : `card-black`; shoe.push({ val: v, suit: s, bjVal: bj, raw: v, suitHtml: `<span class="${colorClass}">${s}</span>` }); } } } for (let i = shoe.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shoe[i], shoe[j]] = [shoe[j], shoe[i]]; } return shoe; }
    function mbjDrawCard() { if(mbjGlobalShoe.length < 52) mbjGlobalShoe = mbjBuildShoe(6); return mbjGlobalShoe.pop(); }

    let mbjState = { status: 'BETTING', time: 15, turnTimer: 0, activeTurn: { seat: null, handIdx: 0 }, dealer: { hand: [], score: 0 }, seats: { 1: null, 2: null, 3: null, 4: null, 5: null } };

    function mbjNextTurn() {
        let seatNum = mbjState.activeTurn.seat, handIdx = mbjState.activeTurn.handIdx;
        if (seatNum !== null) { let seat = mbjState.seats[seatNum]; if (seat && handIdx + 1 < seat.hands.length && seat.hands[handIdx + 1].status === 'PLAYING') { mbjState.activeTurn.handIdx++; mbjState.turnTimer = 15; io.to('mbj').emit('mbjUpdate', { event: 'turn', activeTurn: mbjState.activeTurn, time: mbjState.turnTimer, seats: mbjState.seats }); return; } }
        let nextSeatNum = null, startIdx = seatNum ? parseInt(seatNum) + 1 : 1;
        for (let i = startIdx; i <= 5; i++) { let s = mbjState.seats[i]; if (s && s.hands.some(h => h.status === 'PLAYING')) { nextSeatNum = i; break; } }
        if (nextSeatNum !== null) { mbjState.activeTurn = { seat: nextSeatNum, handIdx: 0 }; mbjState.turnTimer = 15; io.to('mbj').emit('mbjUpdate', { event: 'turn', activeTurn: mbjState.activeTurn, time: mbjState.turnTimer, seats: mbjState.seats }); } 
        else { mbjResolveDealer(); }
    }

    async function mbjResolveDealer() {
        mbjState.status = 'RESOLVING'; mbjState.activeTurn = { seat: null, handIdx: 0 };
        let playersAlive = false;
        for (let i = 1; i <= 5; i++) { if(mbjState.seats[i]) { mbjState.seats[i].hands.forEach(h => { if(h.status === 'STAND') playersAlive = true; }); } }
        let dScore = getBJScore(mbjState.dealer.hand);
        if (playersAlive) { while (dScore < 17) { mbjState.dealer.hand.push(mbjDrawCard()); dScore = getBJScore(mbjState.dealer.hand); } }
        mbjState.dealer.score = dScore;
        let dealerNatural = (mbjState.dealer.hand.length === 2 && getBJScore(mbjState.dealer.hand) === 21);
        let dealerUpcardVal = mbjState.dealer.hand[0] ? mbjState.dealer.hand[0].bjVal : 0;
        let seatResults = {}; 
        
        for (let i = 1; i <= 5; i++) {
            let seat = mbjState.seats[i];
            if (seat && seat.hands.length > 0) {
                let totalWin = 0, totalPush = 0; 
                seat.hands.forEach(h => {
                    if (h.status === 'BUST') return; 
                    let pScore = h.score, payout = 0, isPush = false, refundAmount = 0;
                    let playerNatural = (h.cards.length === 2 && getBJScore(h.cards) === 21) && !h.isSplitHand;
                    if (dealerNatural) { if (playerNatural) isPush = true; else { if (dealerUpcardVal === 10 && h.doubledAmount > 0) refundAmount += h.doubledAmount; payout = 0; } } 
                    else if (playerNatural) payout = h.bet * 2.5; 
                    else if (dScore > 21 || pScore > dScore) payout = h.bet * 2; 
                    else if (pScore === dScore) isPush = true;
                    if (isPush) totalPush += h.bet; else totalWin += (payout + refundAmount);
                });
                let totalBet = seat.hands.reduce((sum, h) => sum + h.bet, 0);
                let netResult = formatTC(totalWin + totalPush - totalBet);
                seatResults[i] = { win: totalWin, push: totalPush, status: netResult > 0 ? 'WIN' : (netResult < 0 ? 'LOSS' : 'PUSH'), net: netResult };
            }
        }
        io.to('mbj').emit('mbjUpdate', { event: 'dealer_resolved', dealerHand: mbjState.dealer.hand, dealerScore: dScore, seats: mbjState.seats, results: seatResults });

        for (let i = 1; i <= 5; i++) {
            let seat = mbjState.seats[i], res = seatResults[i];
            if (seat && res && seat.userId) {
                let totalReturn = formatTC(res.win + res.push);
                if (totalReturn > 0) { try { let u = await User.findById(seat.userId); if (u) { u.credits = formatTC((u.credits || 0) + totalReturn); await u.save(); let targetSocket = connectedUsers[u.username]; if (targetSocket) io.to(targetSocket).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits }); } } catch (err) {} }
                let totalBet = seat.hands.reduce((sum, h) => sum + h.bet, 0), netResult = formatTC(totalReturn - totalBet);
                if (netResult !== 0) { try { await new CreditLog({ username: seat.username, action: 'GAME', amount: netResult, details: 'VIP Blackjack' }).save(); } catch (e) {} }
            }
        }
        setTimeout(() => {
            for (let i = 1; i <= 5; i++) { if (mbjState.seats[i]) { if (mbjState.seats[i].hands.length === 0 || mbjState.seats[i].hands[0].bet === 0) { mbjState.seats[i] = null; } else { mbjState.seats[i].hands = []; } } }
            mbjState.dealer.hand = []; mbjState.time = 15; mbjState.status = 'BETTING'; io.to('mbj').emit('mbjUpdate', { event: 'new_round', seats: mbjState.seats });
        }, 4500); 
    }

    setInterval(() => {
        if (mbjState.status === 'BETTING') {
            let hasBets = Object.values(mbjState.seats).some(s => s && s.hands.length > 0 && s.hands[0].bet > 0);
            if (hasBets) { mbjState.time--; io.to('mbj').emit('mbjUpdate', { event: 'timer', time: mbjState.time, active: true }); } 
            else { mbjState.time = 15; io.to('mbj').emit('mbjUpdate', { event: 'timer', time: mbjState.time, active: false }); }
            
            if (mbjState.time <= 0 && hasBets) {
                for (let i = 1; i <= 5; i++) { if (mbjState.seats[i] && (mbjState.seats[i].hands.length === 0 || mbjState.seats[i].hands[0].bet === 0)) { mbjState.seats[i] = null; } }
                let activeSeats = Object.keys(mbjState.seats).filter(k => mbjState.seats[k] !== null);
                if (activeSeats.length > 0) {
                    mbjState.status = 'DEALING';
                    io.to('mbj').emit('mbjUpdate', { event: 'lock_bets', seats: mbjState.seats });
                    mbjState.dealer.hand = [mbjDrawCard(), mbjDrawCard()];
                    activeSeats.forEach(k => {
                        let c1 = mbjDrawCard(), c2 = mbjDrawCard();
                        mbjState.seats[k].hands[0].cards = [c1, c2]; mbjState.seats[k].hands[0].isSplitHand = false;
                        let score = getBJScore([c1, c2]); mbjState.seats[k].hands[0].score = score;
                        mbjState.seats[k].hands[0].status = score === 21 ? 'BLACKJACK' : 'PLAYING';
                    });
                    let hiddenDealer = [mbjState.dealer.hand[0], { raw: '?', suitHtml: `<span class="card-black">?</span>`, bjVal: 0 }];
                    let animTime = ((activeSeats.length * 2) + 2) * 400 + 400; 
                    io.to('mbj').emit('mbjUpdate', { event: 'deal', seats: mbjState.seats, dealerHand: hiddenDealer });

                    setTimeout(() => {
                        mbjState.activeOrder = activeSeats.filter(k => mbjState.seats[k].hands[0].status === 'PLAYING');
                        if (mbjState.activeOrder.length > 0) {
                            mbjState.status = 'PLAYER_TURN'; mbjState.activeTurn = { seat: mbjState.activeOrder[0], handIdx: 0 }; mbjState.turnTimer = 15;
                            io.to('mbj').emit('mbjUpdate', { event: 'turn', activeTurn: mbjState.activeTurn, time: mbjState.turnTimer, seats: mbjState.seats });
                        } else { mbjResolveDealer(); }
                    }, animTime); 
                }
            }
        } else if (mbjState.status === 'PLAYER_TURN') {
            mbjState.turnTimer--; io.to('mbj').emit('mbjUpdate', { event: 'turn_timer', time: mbjState.turnTimer, activeTurn: mbjState.activeTurn });
            if (mbjState.turnTimer <= 0) { let seat = mbjState.seats[mbjState.activeTurn.seat]; if(seat && seat.hands[mbjState.activeTurn.handIdx]) { seat.hands[mbjState.activeTurn.handIdx].status = 'STAND'; } mbjNextTurn(); }
        }
    }, 1000);

    socket.on('mbjTakeSeat', (seatNum) => { if (!socket.user || mbjState.seats[seatNum] || mbjState.status !== 'BETTING') return; for(let i = 1; i <= 5; i++) { if (mbjState.seats[i] && mbjState.seats[i].userId.toString() === socket.user._id.toString()) return; } mbjState.seats[seatNum] = { userId: socket.user._id, username: socket.user.username, hands: [] }; io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, active: Object.values(mbjState.seats).some(s => s && s.hands.length > 0 && s.hands[0].bet > 0) }); });
    socket.on('mbjLeaveSeat', async () => { if (!socket.user) return; for(let i = 1; i <= 5; i++) { let s = mbjState.seats[i]; if (s && s.userId.toString() === socket.user._id.toString() && mbjState.status === 'BETTING') { if (s.hands.length > 0 && s.hands[0].bet > 0) { try { let u = await User.findById(socket.user._id); if (u) { u.playableCredits = formatTC((u.playableCredits || 0) + s.hands[0].fromPlayable); u.credits = formatTC((u.credits || 0) + s.hands[0].fromMain); await u.save(); socket.emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits }); } } catch(e) {} } mbjState.seats[i] = null; io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, active: Object.values(mbjState.seats).some(st => st && st.hands.length > 0 && st.hands[0].bet > 0) }); break; } } });

    socket.on('mbjPlaceBet', async (amount) => {
        if (!socket.user || mbjState.status !== 'BETTING') return;
        let seatNum = null; for(let i = 1; i <= 5; i++) { if (mbjState.seats[i] && mbjState.seats[i].userId.toString() === socket.user._id.toString()) seatNum = i; }
        if (!seatNum) return; let amt = formatTC(amount);
        try {
            let u = await User.findById(socket.user._id); if (!u) return;
            let deduction = await deductBet(u, amt); if (!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: 'mbj' });
            await u.save();
            let s = mbjState.seats[seatNum]; if (s.hands.length === 0) s.hands.push({ bet: 0, originalBet: 0, doubledAmount: 0, cards: [], score: 0, status: 'WAITING', isSplitHand: false, fromPlayable: 0, fromMain: 0 });
            s.hands[0].bet += amt; s.hands[0].originalBet += amt; s.hands[0].fromPlayable += deduction.fromPlayable; s.hands[0].fromMain += deduction.fromMain;
            socket.emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
            io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, active: true });
        } catch(e) {}
    });

    socket.on('mbjAction', async (actionData) => {
        if (!socket.user || mbjState.status !== 'PLAYER_TURN' || mbjState.activeTurn.seat === null) return;
        let seatNum = mbjState.activeTurn.seat, handIdx = mbjState.activeTurn.handIdx, seat = mbjState.seats[seatNum];
        if (seat.userId.toString() !== socket.user._id.toString()) return; 
        let hand = seat.hands[handIdx];

        try {
            if (actionData.type === 'hit') {
                if (hand.isSplitAce) return; 
                hand.cards.push(mbjDrawCard()); hand.score = getBJScore(hand.cards); mbjState.turnTimer = 15; 
                if (hand.score >= 21) { hand.status = hand.score > 21 ? 'BUST' : 'STAND'; io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn }); setTimeout(() => mbjNextTurn(), 1200); } 
                else { io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn }); }
            } 
            else if (actionData.type === 'stand') { hand.status = 'STAND'; io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn }); mbjNextTurn(); }
            else if (actionData.type === 'double') {
                if (hand.cards.length !== 2) return; let u = await User.findById(socket.user._id); if (!u) return;
                let deduction = await deductBet(u, hand.bet); if (!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: 'mbj' });
                await u.save(); hand.fromPlayable += deduction.fromPlayable; hand.fromMain += deduction.fromMain; hand.doubledAmount = hand.bet; hand.bet *= 2; 
                hand.cards.push(mbjDrawCard()); hand.score = getBJScore(hand.cards); hand.status = hand.score > 21 ? 'BUST' : 'STAND'; mbjState.turnTimer = 15; 
                io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn }); socket.emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits }); setTimeout(() => mbjNextTurn(), 1200);
            }
            else if (actionData.type === 'split') {
                if (hand.cards.length !== 2 || seat.hands.length >= 2) return; 
                let val1 = hand.cards[0].bjVal, val2 = hand.cards[1].bjVal; if (val1 !== val2) return; 
                let u = await User.findById(socket.user._id); if (!u) return;
                let deduction = await deductBet(u, hand.bet); if (!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: 'mbj' });
                await u.save();
                let splitCard = hand.cards.pop();
                let hand2 = { bet: hand.bet, originalBet: hand.bet, doubledAmount: 0, cards: [splitCard], score: 0, status: 'PLAYING', isSplitHand: true, fromPlayable: deduction.fromPlayable, fromMain: deduction.fromMain };
                hand.isSplitHand = true; hand.cards.push(mbjDrawCard()); hand.score = getBJScore(hand.cards); if (hand.score === 21) hand.status = 'STAND';
                hand2.cards.push(mbjDrawCard()); hand2.score = getBJScore(hand2.cards); if (hand2.score === 21) hand2.status = 'STAND';
                seat.hands.push(hand2); mbjState.turnTimer = 15; 
                io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, activeTurn: mbjState.activeTurn }); socket.emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                if(hand.score === 21) setTimeout(() => mbjNextTurn(), 1200); 
            }
        } catch(e) {}
    });

    socket.on('disconnect', async () => {
        if (socket.user) { 
            for(let i = 1; i <= 5; i++) {
                let s = mbjState.seats[i];
                if (s && s.userId.toString() === socket.user._id.toString() && mbjState.status === 'BETTING') {
                    if (s.hands.length > 0 && s.hands[0].bet > 0) { try { let u = await User.findById(socket.user._id); if (u) { u.playableCredits = formatTC((u.playableCredits || 0) + s.hands[0].fromPlayable); u.credits = formatTC((u.credits || 0) + s.hands[0].fromMain); await u.save(); } } catch(e) {} }
                    mbjState.seats[i] = null; io.to('mbj').emit('mbjUpdate', { event: 'sync_seats', seats: mbjState.seats, active: Object.values(mbjState.seats).some(st => st && st.hands.length > 0 && st.hands[0].bet > 0) }); break;
                }
            }
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); delete connectedUsers[socket.user.username];
        }
        if(socket.currentRoom && rooms[socket.currentRoom] > 0) { rooms[socket.currentRoom]--; io.emit('playerCount', rooms); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
