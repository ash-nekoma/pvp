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

let roomRadios = {
    'baccarat': { url: null, requestedBy: null },
    'perya': { url: null, requestedBy: null },
    'dt': { url: null, requestedBy: null },
    'sicbo': { url: null, requestedBy: null }
};

const activeLocks = new Set();

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
            if (refSock) io.to(refSock).emit('balanceUpdateData', { credits: referrer.credits, playable: referrer.playableCredits });
        }
    } catch(e) {}
}

const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/stickntrade';
mongoose.connect(MONGO_URI).then(async () => {
    console.log('✅ Connected to MongoDB Database');
    const adminExists = await User.findOne({ username: 'admin' });
    if (!adminExists) {
        const adminPass = process.env.ADMIN_PASS || 'Kenm44ashley';
        await new User({ username: 'admin', password: adminPass, role: 'Admin', credits: 10000, playableCredits: 0 }).save();
    }
    pushAdminData();
}).catch(err => console.error('❌ MongoDB Connection Error.', err));

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

const txSchema = new mongoose.Schema({ username: String, type: String, amount: Number, ref: String, status: { type: String, default: 'Pending' }, date: { type: Date, default: Date.now } });
const Transaction = mongoose.model('Transaction', txSchema);

const codeSchema = new mongoose.Schema({ batchId: String, amount: Number, code: String, creditType: { type: String, default: 'playable' }, redeemedBy: { type: String, default: null }, date: { type: Date, default: Date.now } });
const GiftCode = mongoose.model('GiftCode', codeSchema);

const creditLogSchema = new mongoose.Schema({ username: String, action: String, amount: Number, details: String, date: { type: Date, default: Date.now } });
const CreditLog = mongoose.model('CreditLog', creditLogSchema);

const adminLogSchema = new mongoose.Schema({ adminName: String, action: String, details: String, date: { type: Date, default: Date.now } });
const AdminLog = mongoose.model('AdminLog', adminLogSchema);

let connectedUsers = {};

let sharedTables = {
    baccarat: { time: 15, maxTime: 15, status: 'BETTING', bets: [] },
    perya: { time: 15, maxTime: 15, status: 'BETTING', bets: [] },
    dt: { time: 10, maxTime: 10, status: 'BETTING', bets: [] },
    sicbo: { time: 10, maxTime: 10, status: 'BETTING', bets: [] }
};

let gameStats = {
    baccarat: { total: 0, Player: 0, Banker: 0, Tie: 0 }, dt: { total: 0, Dragon: 0, Tiger: 0, Tie: 0 },
    sicbo: { total: 0, Big: 0, Small: 0, Triple: 0 }, perya: { total: 0, Yellow: 0, White: 0, Pink: 0, Blue: 0, Red: 0, Green: 0 },
    coinflip: { total: 0, Heads: 0, Tails: 0 }, d20: { total: 0, Win: 0, Lose: 0 }
};

function checkResetStats(game) { 
    if (gameStats[game].total >= 100) { 
        Object.keys(gameStats[game]).forEach(key => { gameStats[game][key] = 0; }); 
    } 
}

function drawCard() {
    const vs = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const ss = ['♠','♣','♥','♦'];
    let v = vs[crypto.randomInt(vs.length)]; let s = ss[crypto.randomInt(ss.length)];
    let bac = isNaN(parseInt(v)) ? (v === 'A' ? 1 : 0) : (v === '10' ? 0 : parseInt(v));
    let dt = (v === 'A') ? 1 : (v === 'K' ? 13 : (v === 'Q' ? 12 : (v === 'J' ? 11 : parseInt(v))));
    let suitHtml = (s === '♥' || s === '♦') ? `<span class="card-red">${s}</span>` : s;
    return { val: v, suit: s, bacVal: bac, dtVal: dt, raw: v, suitHtml: suitHtml };
}

async function resolveSharedRoom(room, table) {
    let resData = {}, winnerStr = '', resStr = '', playerStats = {};

    if (room === 'dt') {
        let dtD = drawCard(), dtT = drawCard();
        winnerStr = dtD.dtVal > dtT.dtVal ? 'Dragon' : (dtT.dtVal > dtD.dtVal ? 'Tiger' : 'Tie');
        resStr = winnerStr === 'Tie' ? `TIE (${dtD.raw} TO ${dtT.raw})` : `${winnerStr.toUpperCase()} (${dtD.raw} TO ${dtT.raw})`;
        resData = { room: 'dt', dCard: dtD, tCard: dtT, winner: winnerStr, resStr };
    } 
    else if (room === 'sicbo') {
        let sbR = [crypto.randomInt(1, 7), crypto.randomInt(1, 7), crypto.randomInt(1, 7)];
        let sbSum = sbR[0] + sbR[1] + sbR[2];
        let sbTrip = (sbR[0] === sbR[1] && sbR[1] === sbR[2]);
        winnerStr = sbTrip ? 'Triple' : (sbSum <= 10 ? 'Small' : 'Big');
        resStr = sbTrip ? `TRIPLE (${sbR[0]})` : `${winnerStr.toUpperCase()} (${sbSum})`;
        resData = { room: 'sicbo', roll: sbR, sum: sbSum, winner: winnerStr, resStr };
    }
    else if (room === 'perya') {
        const cols = ['Yellow','White','Pink','Blue','Red','Green'];
        let pyR = [cols[crypto.randomInt(6)], cols[crypto.randomInt(6)], cols[crypto.randomInt(6)]];
        resData = { room: 'perya', roll: pyR, resStr: pyR.join(',') };
    }
    else if (room === 'baccarat') {
        let pC = [drawCard(), drawCard()], bC = [drawCard(), drawCard()];
        let pS = (pC[0].bacVal + pC[1].bacVal) % 10; let bS = (bC[0].bacVal + bC[1].bacVal) % 10;
        let p3Drawn = false, b3Drawn = false;

        if (pS < 8 && bS < 8) {
            let p3Val = -1;
            if (pS <= 5) { pC.push(drawCard()); p3Val = pC[2].bacVal; pS = (pS + p3Val) % 10; p3Drawn = true; }
            let bDraws = false;
            if (pC.length === 2) { if (bS <= 5) bDraws = true; } 
            else {
                if (bS <= 2) bDraws = true; else if (bS === 3 && p3Val !== 8) bDraws = true;
                else if (bS === 4 && p3Val >= 2 && p3Val <= 7) bDraws = true;
                else if (bS === 5 && p3Val >= 4 && p3Val <= 7) bDraws = true;
                else if (bS === 6 && (p3Val === 6 || p3Val === 7)) bDraws = true;
            }
            if (bDraws) { bC.push(drawCard()); bS = (bS + bC[bC.length-1].bacVal) % 10; b3Drawn = true; }
        }
        winnerStr = pS > bS ? 'Player' : (bS > pS ? 'Banker' : 'Tie');
        resStr = winnerStr === 'Tie' ? `TIE (${pS} TO ${bS})` : `${winnerStr.toUpperCase()} (${pS} TO ${bS})`;
        resData = { room: 'baccarat', pCards: pC, bCards: bC, pScore: pS, bScore: bS, winner: winnerStr, resStr, p3Drawn, b3Drawn };
    }

    table.bets.forEach(b => {
        let payout = 0;
        if (room === 'dt') { 
            if (winnerStr === 'Tie') { if (b.choice === 'Tie') payout = b.amount * 9; else payout = b.amount; } 
            else { if (b.choice === winnerStr) payout = b.amount * 2; }
        } 
        else if (room === 'sicbo') { if (b.choice === winnerStr) payout = b.amount * 2; } 
        else if (room === 'perya') {
            let matches = resData.roll.filter(c => c === b.choice).length;
            if (matches > 0) payout = b.amount + (b.amount * matches);
        } 
        else if (room === 'baccarat') {
            if (winnerStr === 'Tie') { if (b.choice === 'Tie') payout = b.amount * 9; else if (b.choice === 'Player' || b.choice === 'Banker') payout = b.amount; } 
            else if (winnerStr === 'Player') { if (b.choice === 'Player') payout = b.amount * 2; } 
            else if (winnerStr === 'Banker') { if (b.choice === 'Banker') payout = b.amount * 1.95; }
        }

        if (!playerStats[b.userId]) playerStats[b.userId] = { socketId: b.socketId, username: b.username, amountWon: 0, amountBet: 0 };
        playerStats[b.userId].amountBet += b.amount;
        playerStats[b.userId].amountWon += formatTC(payout);
    });

    let roomNames = { 'perya': 'Color Game', 'dt': 'Dragon Tiger', 'sicbo': 'Sic Bo', 'baccarat': 'Baccarat' };

    Object.keys(playerStats).forEach(async (userId) => {
        let st = playerStats[userId]; let user = await User.findById(userId);
        if (user) {
            if (st.amountWon > 0) { user.credits = formatTC((user.credits || 0) + st.amountWon); await user.save(); }
            let net = formatTC(st.amountWon - st.amountBet);
            if (net !== 0) { await new CreditLog({ username: user.username, action: 'GAME', amount: net, details: roomNames[room] }).save(); }
        }
    });

    io.to(room).emit('sharedResults', resData);

    setTimeout(() => { 
        gameStats[room].total++; 
        if(room === 'perya') resData.roll.forEach(c => gameStats.perya[c]++); else gameStats[room][winnerStr]++; 
        checkResetStats(room); 
    }, 2500);
}

setInterval(() => {
    Object.keys(sharedTables).forEach(room => {
        let table = sharedTables[room];
        if (table.status === 'BETTING') {
            table.time--;
            io.to(room).emit('timerUpdate', table.time);

            if (table.time <= 0) {
                table.status = 'RESOLVING';
                io.to(room).emit('lockBets');
                setTimeout(async () => { await resolveSharedRoom(room, table); }, 500);
                setTimeout(() => { table.time = table.maxTime; table.status = 'BETTING'; table.bets = []; io.to(room).emit('newRound'); pushAdminData(); }, 10000); 
            }
        }
    });
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
        
        const gameLogs = await CreditLog.find({ action: 'GAME', date: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
        let houseProfit24h = formatTC(-gameLogs.reduce((sum, l) => sum + l.amount, 0));
        
        const adminLogs = await AdminLog.find().sort({ date: -1 }).limit(100);
        
        let payload = { users, transactions: txs, giftBatches: gcs, adminLogs, stats: { economy: totalMainCredits, approvedDeposits: formatTC(approvedDeposits), limit: globalBankVault, houseProfit: houseProfit24h }, isMaintenance: isMaintenanceMode };
        if(targetSocket) { targetSocket.emit('adminDataSync', payload); } else { io.to('admin_room').emit('adminDataSync', payload); }
    } catch(e) {}
}

let roomsCount = { baccarat: 0, perya: 0, dt: 0, sicbo: 0 };

function getRoomPlayers(room) {
    let playersInRoom = [];
    for (let username in connectedUsers) {
        let sId = connectedUsers[username];
        let s = io.sockets.sockets.get(sId);
        if (s && s.rooms.has(room)) playersInRoom.push(username);
    }
    return playersInRoom;
}

io.on('connection', (socket) => {
    socket.emit('maintenanceToggle', isMaintenanceMode); 
    socket.isAuth = false;

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
            
            if (user.role === 'Admin') { socket.join('admin_room'); }

            sendPulse(`${user.username} logged in.`, 'info');
            pushAdminData();
            
            let now = new Date(), canClaim = true, day = 1, nextClaim = null;
            if (user.dailyReward && user.dailyReward.lastClaim) {
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
            let newUser = new User({ username: data.username, password: data.password, ipAddress: ip, referredBy: refUser ? refUser.username : null });

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
            if (refUser) await new CreditLog({ username: newUser.username, action: 'REFERRAL', amount: 500, details: `Used code ${refUser.username}` }).save();
            
            sendPulse(`New account created: ${data.username}`, 'success');
            pushAdminData();
            socket.emit('registerSuccess', 'Account created! You may now login.');
        } catch(e) { socket.emit('authError', 'System Error: ' + e.message); } finally { socket.isAuth = false; }
    });

    socket.on('adminAction', async (data) => {
        if (!socket.user || socket.user.role !== 'Admin') return;
        try {
            if (data.type === 'ban') {
                await User.findByIdAndUpdate(data.id, { status: 'Banned' });
                const targetUser = await User.findById(data.id);
                if (targetUser && connectedUsers[targetUser.username]) {
                    const targetSocket = io.sockets.sockets.get(connectedUsers[targetUser.username]);
                    if (targetSocket) {
                        targetSocket.emit('authError', 'You have been banned by an administrator.');
                        targetSocket.disconnect(true);
                    }
                }
            } 
            else if (data.type === 'unban') {
                await User.findByIdAndUpdate(data.id, { status: 'Offline' });
            }
            else if (data.type === 'editUser') {
                await User.findByIdAndUpdate(data.id, { role: data.role, credits: data.credits, playableCredits: data.playableCredits });
                const updatedUser = await User.findById(data.id);
                if(updatedUser && connectedUsers[updatedUser.username]) {
                    io.to(connectedUsers[updatedUser.username]).emit('balanceUpdateData', { credits: updatedUser.credits, playable: updatedUser.playableCredits });
                }
            }
            else if (data.type === 'resolveTx') {
                const tx = await Transaction.findById(data.id);
                if (tx && tx.status === 'Pending') {
                    tx.status = data.status; await tx.save();
                    if (data.status === 'Approved' && tx.type === 'Deposit') {
                        const u = await User.findOne({ username: tx.username });
                        if (u) { u.credits += tx.amount; await u.save();
                            if (connectedUsers[u.username]) io.to(connectedUsers[u.username]).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                        }
                    } else if (data.status === 'Rejected' && tx.type === 'Withdrawal') {
                        const u = await User.findOne({ username: tx.username });
                        if (u) { u.credits += tx.amount; await u.save(); 
                            if (connectedUsers[u.username]) io.to(connectedUsers[u.username]).emit('balanceUpdateData', { credits: u.credits, playable: u.playableCredits });
                        }
                    }
                }
            }
            else if (data.type === 'createBatch') {
                let batchId = crypto.randomBytes(4).toString('hex').toUpperCase();
                let codesToInsert = [];
                for(let i=0; i < data.count; i++) {
                    codesToInsert.push({ batchId, amount: data.amount, code: crypto.randomBytes(6).toString('hex').toUpperCase(), creditType: data.creditType });
                }
                await GiftCode.insertMany(codesToInsert);
            }
            else if (data.type === 'deleteBatch') {
                await GiftCode.deleteMany({ batchId: data.batchId });
            }
            else if (data.type === 'sendUpdate') {
                io.emit('chatMessage', { user: 'SYSTEM', text: data.msg, sys: true });
            }
            pushAdminData();
        } catch(e) { console.log("Admin Action Error: ", e); }
    });

    socket.on('claimDaily', async () => {
        if (!socket.user) return;
        const user = await User.findById(socket.user._id);
        let now = new Date();
        if (user.dailyReward.lastClaim && (now - user.dailyReward.lastClaim) / (1000 * 60 * 60) < 24) return; 

        let day = (user.dailyReward.streak % 7) + 1;
        const rewards = [100, 250, 500, 750, 1000, 1500, 2000];
        let amt = formatTC(rewards[day - 1]);

        user.playableCredits = formatTC((user.playableCredits || 0) + amt); 
        user.dailyReward.lastClaim = now; user.dailyReward.streak += 1; await user.save();
        
        await new CreditLog({ username: user.username, action: 'GIFT', amount: amt, details: `Daily Reward` }).save();
        sendPulse(`${user.username} claimed Day ${day} Daily Reward.`, 'info');
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
            socket.emit('transactionsData', await Transaction.find({ username: socket.user.username }).sort({ date: -1 }));
        }
    });

    socket.on('playSolo', async (data) => {
        if (isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.game });
        if (!socket.user) return;
        
        const lockId = socket.user._id.toString();
        if (activeLocks.has(lockId)) return;
        activeLocks.add(lockId);

        try {
            const user = await User.findById(socket.user._id);
            if (!user) return;
            
            let isNewBet = (data.game === 'd20' || data.game === 'coinflip');
            
            if (isNewBet) {
                let amt = formatTC(data.bet || 0);
                
                if (data.game === 'd20') {
                    if (isNaN(amt) || amt < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.game }); return; }
                    if (data.choice !== 'Odd' && data.choice !== 'Even') { socket.emit('localGameError', { msg: 'INVALID CHOICE', game: 'd20' }); return; }
                } else if (data.game === 'coinflip') {
                    if (isNaN(amt) || amt < 10) { socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.game }); return; }
                    if (data.choice !== 'Heads' && data.choice !== 'Tails') { socket.emit('localGameError', { msg: 'INVALID CHOICE', game: 'coinflip' }); return; }
                }
                
                if (amt > 50000) { socket.emit('localGameError', { msg: 'MAX TOTAL BET IS 50K TC', game: data.game }); return; }
                
                let deduction = await deductBet(user, amt);
                if (!deduction.success) {
                    socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.game }); return;
                }
                await user.save();
                processReferralBetCommission(user, amt);
            }

            let payout = 0;

            if (data.game === 'd20') {
                let roll = crypto.randomInt(1, 21);
                let wonAny = false;
                let isEven = roll % 2 === 0;
                
                if ((data.choice === 'Even' && isEven) || (data.choice === 'Odd' && !isEven)) {
                    payout = formatTC(data.bet * 1.95);
                    wonAny = true;
                }
                
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `D20` }).save();
                socket.emit('d20Result', { roll, payout, bet: data.bet, resStr: `ROLLED ${roll}`, newBalance: { credits: user.credits, playable: user.playableCredits }});
                
                setTimeout(() => { gameStats.d20.total++; if (wonAny) gameStats.d20.Win++; else gameStats.d20.Lose++; checkResetStats('d20'); }, 1500);
            } 
            else if (data.game === 'coinflip') {
                let result = crypto.randomInt(2) === 0 ? 'Heads' : 'Tails';
                if (data.choice === result) payout = formatTC(data.bet * 1.95);
                
                user.credits = formatTC(user.credits + payout); await user.save();
                await new CreditLog({ username: user.username, action: 'GAME', amount: formatTC(payout - data.bet), details: `Coin Flip` }).save();
                socket.emit('coinResult', { result, payout, bet: data.bet, resStr: `${result.toUpperCase()}`, newBalance: { credits: user.credits, playable: user.playableCredits }});
                
                setTimeout(() => { gameStats.coinflip.total++; gameStats.coinflip[result]++; checkResetStats('coinflip'); }, 1500);
            }
        } finally { activeLocks.delete(lockId); }
    });

    socket.on('joinRoom', (room) => { 
        if(socket.currentRoom) { socket.leave(socket.currentRoom); roomsCount[socket.currentRoom]--; }
        socket.join(room); socket.currentRoom = room; roomsCount[room]++; 
        
        let pCount = roomsCount;
        pCount[room] = getRoomPlayers(room).length;
        io.emit('playerCount', pCount); 

        if (roomRadios[room] && roomRadios[room].url) {
            socket.emit('radioSync', roomRadios[room]);
        } else {
            socket.emit('radioStop');
        }

        if(sharedTables[room]) {
            socket.emit('timerUpdate', sharedTables[room].time);
        }
    });
    
    socket.on('leaveRoom', (room) => { 
        socket.leave(room); socket.currentRoom = null;
        if (roomsCount[room] > 0) roomsCount[room]--; 
        let pCount = roomsCount; pCount[room] = getRoomPlayers(room).length;
        io.emit('playerCount', pCount); 
    });
    
    socket.on('sendChat', (data) => { 
        if (!socket.user || !socket.currentRoom) return;
        let msg = data.msg.trim();
        
        if (msg.startsWith('/play ')) {
            let url = msg.substring(6).trim();
            if (url) {
                roomRadios[socket.currentRoom] = { url: url, requestedBy: socket.user.username };
                io.to(socket.currentRoom).emit('radioPlay', roomRadios[socket.currentRoom]);
                io.to(socket.currentRoom).emit('chatMessage', { user: 'SYSTEM', text: `🎵 ${socket.user.username} started playing music.`, sys: true });
            }
            return;
        } else if (msg === '/stop') {
            roomRadios[socket.currentRoom] = { url: null, requestedBy: null };
            io.to(socket.currentRoom).emit('radioStop');
            io.to(socket.currentRoom).emit('chatMessage', { user: 'SYSTEM', text: `🔇 Music stopped by ${socket.user.username}.`, sys: true });
            return;
        }

        socket.broadcast.to(socket.currentRoom).emit('chatMessage', { user: socket.user.username, text: msg, sys: false }); 
    });

    socket.on('voiceStream', (data) => {
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('voiceStream', data);
        }
    });

    socket.on('pttActive', (isActive) => {
        if (socket.currentRoom && socket.user) {
            socket.to(socket.currentRoom).emit('pttUpdate', { user: socket.user.username, active: isActive });
        }
    });
    
    socket.on('getRoomPlayers', (room) => { socket.emit('roomPlayersList', getRoomPlayers(room)); });
    
    socket.on('placeSharedBet', async (data) => {
        if (isMaintenanceMode) return socket.emit('localGameError', { msg: 'SYSTEM UNDER MAINTENANCE', game: data.room });
        if (!socket.user) return;
        let table = sharedTables[data.room];
        if (!table || table.status !== 'BETTING' || table.time <= 0) return socket.emit('localGameError', { msg: 'BETS ARE CLOSED FOR THIS ROUND', game: data.room });
        
        const lockId = socket.user._id.toString();
        if (activeLocks.has(lockId)) return;
        activeLocks.add(lockId);

        try {
            const user = await User.findById(socket.user._id); if (!user) return;
            let amt = formatTC(data.amount); if (isNaN(amt) || amt < 10) return socket.emit('localGameError', { msg: 'MIN BET IS 10 TC', game: data.room });
            let currentTileBet = table.bets.filter(b => b.userId.toString() === user._id.toString() && b.room === data.room && b.choice === data.choice).reduce((sum, b) => sum + b.amount, 0);
            if (currentTileBet + amt > 50000) return socket.emit('localGameError', { msg: 'MAX 50K TC PER TILE', game: data.room });
            
            let deduction = await deductBet(user, amt);
            if (!deduction.success) return socket.emit('localGameError', { msg: 'INSUFFICIENT TC', game: data.room });
            await user.save();
            
            table.bets.push({ userId: user._id, socketId: socket.id, username: user.username, room: data.room, choice: data.choice, amount: amt, fromPlayable: deduction.fromPlayable, fromMain: deduction.fromMain });
            socket.emit('sharedBetConfirmed', { choice: data.choice, amount: amt, room: data.room, newBalance: { credits: user.credits, playable: user.playableCredits } });
        } finally { activeLocks.delete(lockId); }
    });

    socket.on('undoSharedBet', async (data) => {
        let table = sharedTables[data.room];
        if (!socket.user || !table || table.status !== 'BETTING' || table.time <= 0) return;
        
        const lockId = socket.user._id.toString();
        if (activeLocks.has(lockId)) return;
        activeLocks.add(lockId);

        try {
            for (let i = table.bets.length - 1; i >= 0; i--) {
                let b = table.bets[i];
                if (b.userId.toString() === socket.user._id.toString() && b.room === data.room) {
                    let user = await User.findById(socket.user._id);
                    if (user) {
                        user.playableCredits = formatTC((user.playableCredits || 0) + b.fromPlayable); user.credits = formatTC((user.credits || 0) + b.fromMain);
                        await user.save(); socket.emit('balanceUpdateData', { credits: user.credits, playable: user.playableCredits }); socket.emit('undoSuccess', { choice: b.choice, amount: b.amount, newBalance: { credits: user.credits, playable: user.playableCredits } });
                    }
                    table.bets.splice(i, 1); break;
                }
            }
        } finally { activeLocks.delete(lockId); }
    });

    socket.on('disconnect', async () => {
        if (socket.user) { 
            await User.findByIdAndUpdate(socket.user._id, { status: 'Offline' }); delete connectedUsers[socket.user.username];
        }
        if(socket.currentRoom && roomsCount[socket.currentRoom] > 0) { roomsCount[socket.currentRoom]--; io.emit('playerCount', roomsCount); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Backend running on port ${PORT}`));
