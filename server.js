require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- MONGODB SCHEMA ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true },
    displayName: { type: String, required: true },
    wallet_tc: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- SERVER GAME STATE ---
const room = {
    p1: null, p2: null, 
    p1Score: 0, p2Score: 0, 
    target: 1, game: 'dice', 
    pot: 0, status: 'waiting', turn: 1, 
    p1Roll: 0, spectators: {}
};

io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);
    
    // Auto-login for testing (Bypassing password for now to map your UI)
    socket.on('auth', async (username) => {
        let user = await User.findOne({ username: username.toLowerCase() });
        if(!user) user = await User.create({ username: username.toLowerCase(), displayName: username });
        socket.username = user.displayName;
        socket.emit('auth-success', { name: user.displayName, wallet: user.wallet_tc });
        socket.emit('room-update', room);
    });

    // Chat
    socket.on('send-chat', (text) => {
        io.emit('chat-message', { sender: socket.username, text });
    });

    // Taking a Seat
    socket.on('take-seat', (seatNum) => {
        if(seatNum === 1 && !room.p1) room.p1 = socket.username;
        if(seatNum === 2 && !room.p2) room.p2 = socket.username;
        
        if(room.p1 && room.p2) {
            room.status = 'playing';
            io.emit('system-msg', "MATCH STARTED! P1 TURN.");
        }
        io.emit('room-update', room);
    });

    // Game Logic (Dice Template)
    socket.on('play-turn', async (action) => {
        if(room.status !== 'playing') return;
        if(room.turn === 1 && socket.username !== room.p1) return;
        if(room.turn === 2 && socket.username !== room.p2) return;

        if(room.game === 'dice' && action === 'roll') {
            const roll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
            
            if(room.turn === 1) {
                room.p1Roll = roll;
                room.turn = 2;
                io.emit('game-event', { type: 'dice-roll', p: 1, val: roll });
                io.emit('system-msg', `P1 rolled ${roll}. P2 Turn.`);
            } else {
                io.emit('game-event', { type: 'dice-roll', p: 2, val: roll });
                
                // Calculate Winner
                setTimeout(() => {
                    if(room.p1Roll > roll) {
                        room.p1Score++;
                        io.emit('system-msg', `P1 wins the round!`);
                    } else if (roll > room.p1Roll) {
                        room.p2Score++;
                        io.emit('system-msg', `P2 wins the round!`);
                    } else {
                        io.emit('system-msg', `DRAW!`);
                    }
                    
                    // Check Match Win
                    if(room.p1Score >= room.target) {
                        room.status = 'game-over';
                        io.emit('match-over', { winner: room.p1 });
                    } else if (room.p2Score >= room.target) {
                        room.status = 'game-over';
                        io.emit('match-over', { winner: room.p2 });
                    } else {
                        room.turn = 1; // Reset for next round
                    }
                    io.emit('room-update', room);
                }, 1000);
            }
            io.emit('room-update', room);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 DUEL ARENA Live on port ${PORT}`));
