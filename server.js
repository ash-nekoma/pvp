require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- MONGODB SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true },
    displayName: { type: String, required: true }, 
    password: { type: String, required: true },
    wallet_tc: { type: Number, default: 0 },
    role: { type: String, default: 'player' }
});
const User = mongoose.model('User', userSchema);

const bankSchema = new mongoose.Schema({
    username: String,
    type: String, // 'deposit' or 'withdraw'
    amount: Number,
    status: { type: String, default: 'pending' }
});
const BankRequest = mongoose.model('BankRequest', bankSchema);

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Vault Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- GLOBAL GAME STATE ---
const state = {
    p1: null, p2: null,
    p1Score: 0, p2Score: 0,
    targetScore: 1, game: 'dice',
    status: 'waiting', turn: 1,
    tempData: {}
};

// --- WEBSOCKETS ---
io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);

    // 1. AUTHENTICATION (Login & Registration)
    socket.on('auth-attempt', async (data) => {
        const { username, password } = data;
        if(username.length < 3 || username.length > 12) return socket.emit('auth-error', 'Username must be 3-12 chars.');
        
        try {
            let user = await User.findOne({ username: username.toLowerCase() });
            if (!user) {
                const hashed = await bcrypt.hash(password, 10);
                // Make the first registered user an Admin automatically for testing
                const isFirst = (await User.countDocuments()) === 0; 
                user = await User.create({ username: username.toLowerCase(), displayName: username, password: hashed, role: isFirst ? 'admin' : 'player' });
            } else {
                const isMatch = await bcrypt.compare(password, user.password);
                if (!isMatch) return socket.emit('auth-error', 'INVALID PASSWORD.');
            }
            socket.username = user.displayName;
            socket.role = user.role;
            socket.emit('auth-success', { name: user.displayName, wallet: user.wallet_tc, role: user.role });
            socket.emit('game-state-update', state); // Send current board
        } catch (err) {
            socket.emit('auth-error', 'SERVER ERROR.');
        }
    });

    // 2. BANK SYSTEM
    socket.on('request-bank-tx', async (data) => {
        if (!socket.username) return;
        if (data.type === 'withdraw') {
            const user = await User.findOne({ displayName: socket.username });
            if (user.wallet_tc < data.amount) return socket.emit('chat-message', { sender: 'BANK', text: 'Insufficient TC.', type: 'sys' }); 
        }
        await BankRequest.create({ username: socket.username, type: data.type, amount: data.amount });
        socket.emit('chat-message', { sender: 'BANK', text: 'Request sent to Admin.', type: 'sys' });
        io.emit('admin-bank-queue-update', await BankRequest.find({ status: 'pending' })); 
    });

    socket.on('admin-fetch-bank-queue', async () => {
        if (socket.role !== 'admin') return;
        socket.emit('admin-bank-queue-update', await BankRequest.find({ status: 'pending' }));
    });

    socket.on('admin-process-bank', async (data) => {
        if (socket.role !== 'admin') return;
        const req = await BankRequest.findById(data.requestId);
        if (!req || req.status !== 'pending') return;

        req.status = data.action === 'approve' ? 'approved' : 'denied';
        await req.save();

        if (data.action === 'approve') {
            const user = await User.findOne({ displayName: req.username });
            if (user) {
                user.wallet_tc += (req.type === 'deposit' ? req.amount : -req.amount);
                await user.save();
                const sockets = await io.fetchSockets();
                for (const s of sockets) {
                    if (s.username === req.username) {
                        s.emit('wallet-update', user.wallet_tc);
                        s.emit('chat-message', { sender: 'BANK', text: `${req.type.toUpperCase()} of ${req.amount} TC Approved!`, type: 'sys' });
                    }
                }
            }
        }
        socket.emit('admin-bank-queue-update', await BankRequest.find({ status: 'pending' }));
    });

    // 3. CHAT
    socket.on('send-chat', (text) => {
        if(!socket.username) return;
        io.emit('chat-message', { sender: socket.username, text, role: socket.role });
    });

    // 4. GAME SYSTEM (Seating & Turn Logic)
    socket.on('take-seat', (seat) => {
        if(seat === 1 && !state.p1 && socket.username !== state.p2) state.p1 = socket.username;
        if(seat === 2 && !state.p2 && socket.username !== state.p1) state.p2 = socket.username;
        
        if(state.p1 && state.p2 && state.status === 'waiting') {
            state.status = 'playing';
            state.turn = 1;
            io.emit('chat-message', { sender: 'SYSTEM', text: 'MATCH STARTED!', type: 'sys' });
        }
        io.emit('game-state-update', state);
    });

    socket.on('play-turn', (action) => {
        if(state.status !== 'playing') return;
        if(state.turn === 1 && socket.username !== state.p1) return;
        if(state.turn === 2 && socket.username !== state.p2) return;

        // Simplistic Dice Logic Example
        const roll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
        
        if(state.turn === 1) {
            state.tempData.p1Roll = roll;
            state.turn = 2;
            io.emit('game-anim', { p: 1, roll: roll });
        } else {
            const p1 = state.tempData.p1Roll;
            io.emit('game-anim', { p: 2, roll: roll });
            
            setTimeout(() => {
                if(p1 > roll) state.p1Score++;
                else if(roll > p1) state.p2Score++;
                
                if(state.p1Score >= state.targetScore) { state.status = 'waiting'; state.p1 = null; state.p2 = null; state.p1Score=0; state.p2Score=0; io.emit('match-over', state.p1); }
                else if(state.p2Score >= state.targetScore) { state.status = 'waiting'; state.p1 = null; state.p2 = null; state.p1Score=0; state.p2Score=0; io.emit('match-over', state.p2); }
                else state.turn = 1;
                
                io.emit('game-state-update', state);
            }, 2000);
        }
        io.emit('game-state-update', state);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 DUEL ARENA Live on port ${PORT}`));
