require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const roomManager = require('./services/RoomManager');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Basic health check
app.get('/', (req, res) => {
    res.send('AroundU Backend is running');
});

// Initialize Bots
const BotManager = require('./services/BotManager');
BotManager.initialize(process.env.GROQ_API_KEY);

const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST']
    }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initial user setup
    const user = roomManager.createUser(socket.id);
    socket.emit('session_config', { user });

    // Handle user location registration
    socket.on('register_location', ({ lat, lon, radius }) => {
        if (!lat || !lon || !radius) {
            socket.emit('error', { message: 'Invalid location data' });
            return;
        }

        const updatedUser = roomManager.registerLocation(socket.id, lat, lon, radius);
        if (updatedUser) {
            socket.emit('registration_success', { user: updatedUser });

            // Immediately send nearby users
            const nearbyUsers = roomManager.findNearbyUsers(socket.id);
            socket.emit('nearby_users', { users: nearbyUsers });
        }
    });

    // Handle request to refresh nearby users
    socket.on('get_nearby_users', () => {
        const nearbyUsers = roomManager.findNearbyUsers(socket.id);
        socket.emit('nearby_users', { users: nearbyUsers });
    });

    // Handle profile update
    socket.on('update_profile', ({ username, gender, interest }) => {
        const updatedUser = roomManager.updateProfile(socket.id, { username, gender, interest });
        if (updatedUser) {
            socket.emit('profile_updated', { user: updatedUser });
        }
    });

    // Handle Start Matching (Direct Match Flow)
    socket.on('start_matching', () => {
        const currentUser = roomManager.getUser(socket.id);
        if (!currentUser) return;

        // Reset any existing room if they somehow got here
        if (currentUser.roomId) {
            roomManager.leaveRoom(socket.id);
            socket.leave(currentUser.roomId);
        }

        const attemptMatch = (matchType = 'all') => {
            const user = roomManager.getUser(socket.id);
            if (!user || user.roomId) return false;

            let match = null;
            if (matchType === 'real') {
                const realUser = roomManager.findRealMatch(socket.id);
                if (realUser) match = { type: 'real', user: realUser };
            } else {
                match = roomManager.findMatch(socket.id);
            }

            if (!match) return false;

            const targetId = match.user.id;
            const room = roomManager.createPrivateRoom(socket.id, targetId);

            if (room) {
                socket.join(room.id);

                if (match.type === 'real') {
                    const targetSocket = io.sockets.sockets.get(targetId);
                    if (targetSocket) {
                        targetSocket.join(room.id);
                    }
                }

                const uiUsers = room.users.map(u => ({
                    ...u,
                    username: u.id.startsWith('bot-') ? 'Stranger' : u.username
                }));

                io.to(room.id).emit('room_joined', {
                    room: { ...room, users: uiUsers }
                });
                io.to(room.id).emit('room_users', { users: uiUsers });

                if (match.type === 'bot') {
                    const duration = (Math.floor(Math.random() * (180 - 120 + 1)) + 120) * 1000;
                    setTimeout(() => {
                        const currentRoom = roomManager.rooms.get(room.id);
                        if (currentRoom) {
                            io.to(room.id).emit('chat_ended', { reason: 'partner_left', autoClose: true });
                            roomManager.leaveRoom(socket.id);
                            socket.leave(room.id);
                        }
                    }, duration);

                    setTimeout(async () => {
                        const greetings = ["Hi", "Hey", "Hello", "Sup?", "Kya haal hai?", "Hlo", "Oi"];
                        const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
                        const greeting = await BotManager.generateResponse(match.user.id, randomGreeting);
                        if (greeting) {
                            socket.emit('user_typing', { userId: match.user.id, isTyping: true });
                            setTimeout(() => {
                                socket.emit('user_typing', { userId: match.user.id, isTyping: false });
                                socket.emit('receive_message', {
                                    id: Date.now().toString(),
                                    userId: match.user.id,
                                    username: 'Stranger',
                                    avatar: match.user.avatar,
                                    text: greeting.text,
                                    timestamp: new Date().toISOString()
                                });
                            }, greeting.delay);
                        }
                    }, 1000);
                }
                return true;
            }
            return false;
        };

        // Step 1: Try to find a real user immediately
        const matchedNow = attemptMatch('real');

        if (!matchedNow) {
            // Step 2: If no real user, wait 6 seconds and try again (including Bot fallback)
            setTimeout(() => {
                // Check if user is still waiting and not already matched
                const userAfterDelay = roomManager.getUser(socket.id);
                if (userAfterDelay && !userAfterDelay.roomId) {
                    attemptMatch('all');
                }
            }, 6000);
        }
    });

    // Handle chat request (Legacy - keeping for backward compatibility if needed, but primarily using start_matching now)
    socket.on('request_chat', ({ targetUserId }) => {
        const currentUser = roomManager.getUser(socket.id);

        // Check if target is a bot
        const bot = BotManager.getBotById(targetUserId);
        if (bot) {
            // Auto-create room with bot
            const room = roomManager.createPrivateRoom(currentUser.id, targetUserId);
            if (room) {
                socket.join(room.id);
                socket.emit('room_joined', { room });
                socket.emit('room_users', { users: room.users });

                // Initial greeting from bot
                setTimeout(async () => {
                    const greeting = await BotManager.generateResponse(bot.id, "Hi");
                    if (greeting) {
                        socket.emit('user_typing', { userId: bot.id, isTyping: true });
                        setTimeout(() => {
                            socket.emit('user_typing', { userId: bot.id, isTyping: false });
                            socket.emit('receive_message', {
                                id: Date.now().toString(),
                                userId: bot.id,
                                username: bot.username,
                                avatar: bot.avatar,
                                text: greeting.text,
                                timestamp: new Date().toISOString()
                            });
                        }, greeting.delay);
                    }
                }, 500);
            }
            return;
        }

        const targetUser = roomManager.getUser(targetUserId);

        if (!currentUser || !targetUser) {
            socket.emit('error', { message: 'User not found' });
            return;
        }

        if (targetUser.status !== 'AVAILABLE') {
            socket.emit('error', { message: 'User is currently busy' });
            return;
        }

        // Notify target user
        io.to(targetUserId).emit('incoming_request', {
            from: {
                id: currentUser.id,
                username: currentUser.username,
                avatar: currentUser.avatar
            }
        });
    });

    // Handle chat response (accept/reject)
    socket.on('respond_chat', ({ targetUserId, accept }) => {
        const currentUser = roomManager.getUser(socket.id);

        if (accept) {
            // Try to create room
            const room = roomManager.createPrivateRoom(currentUser.id, targetUserId);

            if (room) {
                // Join both sockets to the room
                socket.join(room.id);
                const targetSocket = io.sockets.sockets.get(targetUserId);
                if (targetSocket) {
                    targetSocket.join(room.id);
                }

                // Notify both users
                io.to(room.id).emit('room_joined', { room });

                // Send initial users list
                io.to(room.id).emit('room_users', { users: room.users });
            } else {
                socket.emit('error', { message: 'Could not create chat room. User might be busy.' });
                io.to(targetUserId).emit('chat_rejected', { fromId: socket.id });
            }
        } else {
            // Notify requester that request was rejected
            io.to(targetUserId).emit('chat_rejected', { fromId: socket.id });
        }
    });

    // Handle messages
    socket.on('send_message', async (messageText) => {
        const user = roomManager.users.get(socket.id);
        if (!user || !user.roomId) return;

        const room = roomManager.rooms.get(user.roomId);
        const message = {
            id: Date.now().toString(),
            userId: user.id,
            username: user.username,
            avatar: user.avatar,
            text: messageText,
            timestamp: new Date().toISOString()
        };

        io.to(user.roomId).emit('receive_message', message);

        // Check if chatting with a Bot
        if (room && room.type === 'private_bot' && room.botId) {
            const botId = room.botId;
            const bot = BotManager.getBotById(botId);

            // Trigger AI response
            if (bot) {
                // Simulate reading time
                setTimeout(async () => {
                    // Show typing indicator
                    io.to(user.roomId).emit('user_typing', { userId: bot.id, isTyping: true });

                    const response = await BotManager.generateResponse(botId, messageText);

                    if (response) {
                        // Send response after simulated delay
                        setTimeout(() => {
                            io.to(user.roomId).emit('user_typing', { userId: bot.id, isTyping: false });

                            const botMsg = {
                                id: Date.now().toString(),
                                userId: bot.id,
                                username: 'Stranger', // Hide bot name
                                avatar: bot.avatar,
                                text: response.text,
                                timestamp: new Date().toISOString()
                            };
                            io.to(user.roomId).emit('receive_message', botMsg);
                        }, response.delay);
                    } else {
                        io.to(user.roomId).emit('user_typing', { userId: bot.id, isTyping: false });
                    }

                }, 1000);
            }
        }
    });

    // Handle typing
    socket.on('typing', (isTyping) => {
        const user = roomManager.users.get(socket.id);
        if (!user || !user.roomId) return;

        socket.to(user.roomId).emit('user_typing', { userId: user.id, isTyping });
    });

    // Handle disconnect/leave
    socket.on('leave_room', () => {
        const result = roomManager.leaveRoom(socket.id);
        if (result) {
            socket.leave(result.roomId);
            const { roomId, user, roomDestroyed, remainingUsers, wasPrivate } = result;

            if (wasPrivate && roomDestroyed && remainingUsers.length > 0) {
                // Notify the other user that chat ended
                const otherUser = remainingUsers[0];
                io.to(otherUser.id).emit('chat_ended', { reason: 'partner_left' });

                // Make sure other socket leaves room too
                const otherSocket = io.sockets.sockets.get(otherUser.id);
                if (otherSocket) otherSocket.leave(roomId);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const result = roomManager.removeUser(socket.id);

        if (result) {
            const { roomId, user, roomDestroyed, remainingUsers, wasPrivate } = result;

            if (wasPrivate && roomDestroyed && remainingUsers.length > 0) {
                const otherUser = remainingUsers[0];
                io.to(otherUser.id).emit('chat_ended', { reason: 'partner_disconnected' });

                const otherSocket = io.sockets.sockets.get(otherUser.id);
                if (otherSocket) otherSocket.leave(roomId);
            } else if (!roomDestroyed) {
                socket.to(roomId).emit('user_left', { userId: user.id });
                socket.to(roomId).emit('room_users', { users: remainingUsers });
            }
        }
    });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
