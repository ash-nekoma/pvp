require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // For encrypting passwords

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve your HTML, CSS, and client-side JS from the 'public' folder
app.use(express.static('public'));
app.use(express.json());

// ==========================================
// 1. MONGODB SCHEMAS (The Database Blueprints)
// ==========================================

// The Player Profile
const userSchema = new mongoose.Schema({
    // username is forced to lowercase to prevent "User1" vs "user1" exploits
    username: { type: String, required: true, unique: true, lowercase: true }, 
    displayName: { type: String, required: true }, // Keeps their original uppercase/lowercase typing
    password: { type: String, required: true },
    wallet_tc: { type: Number, default: 0 },
    role: { type: String, default: 'player' }, // 'admin' or 'player'
    isBanned: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

// The Bank Queue
const bankSchema = new mongoose.Schema({
    username: String,
    type: String, // 'deposit' or 'withdraw'
    amount: Number,
    status: { type: String, default: 'pending' }, // Admin changes this to 'approved'
    timestamp: { type: Date, default: Date.now }
});
const BankRequest = mongoose.model('BankRequest', bankSchema);

// Connect to the Vault
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Vault Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));


// ==========================================
// 2. SOCKET CONNECTIONS & AUTHENTICATION
// ==========================================

io.on('connection', (socket) => {
    console.log(`🔌 New Connection Detected: ${socket.id}`);

    // Listen for login attempts from the HTML
    socket.on('auth-attempt', async (data) => {
        const { username, password } = data;
        
        // Basic length validation before hitting the database
        if (!username || username.length < 3 || username.length > 12) {
            return socket.emit('auth-error', 'Username must be 3-12 characters.');
        }
        if (!password || password.length < 4) {
            return socket.emit('auth-error', 'Password too short.');
        }

        try {
            // Find user case-insensitively
            let user = await User.findOne({ username: username.toLowerCase() });
            
            if (!user) {
                // REGISTRATION: Create a new account if they don't exist
                const hashedPassword = await bcrypt.hash(password, 10);
                user = await User.create({ 
                    username: username.toLowerCase(), 
                    displayName: username, 
                    password: hashedPassword 
                });
                console.log(`👤 New User Registered: ${user.displayName}`);
            } else {
                // LOGIN: Verify existing user
                if (user.isBanned) return socket.emit('auth-error', 'ACCOUNT BANNED.');
                
                const isMatch = await bcrypt.compare(password, user.password);
                if (!isMatch) return socket.emit('auth-error', 'INVALID PASSWORD.');
            }

            // Lock the session to this specific socket
            socket.username = user.displayName;
            socket.role = user.role;
            
            // Tell the HTML the login worked and send their real wallet balance
            socket.emit('auth-success', { 
                name: user.displayName, 
                wallet: user.wallet_tc, 
                role: user.role 
            });

        } catch (err) {
            console.error("Auth Error:", err);
            socket.emit('auth-error', 'CRITICAL SERVER ERROR.');
        }
    });

    // Disconnect cleanup
    socket.on('disconnect', () => {
        console.log(`🔌 Disconnected: ${socket.username || socket.id}`);
        // Future logic: Remove player from seat if they disconnect mid-game
    });
});

// Boot up the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 DUEL ARENA Server Live on Port ${PORT}`));
