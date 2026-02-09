const { v4: uuidv4 } = require('uuid');
const { uniqueUsernameGenerator, adjectives, nouns } = require('unique-username-generator');
const { getDistanceFromLatLonInMeters } = require('../utils/geo');

const BotManager = require('./BotManager');

class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomId -> Room object
        this.users = new Map(); // socketId -> User object
    }

    // Generate a random anonymous user
    createUser(socketId) {
        const config = {
            dictionaries: [adjectives, nouns],
            separator: ' ',
            length: 2,
            style: 'capital'
        };

        const username = uniqueUsernameGenerator(config);
        const user = {
            id: socketId,
            username: username,
            avatar: Math.floor(Math.random() * 10) + 1, // 1-10 for avatar selection
            roomId: null,
            lat: null,
            lon: null,
            radius: null,
            status: 'AVAILABLE', // 'AVAILABLE', 'BUSY'
            joinedAt: Date.now()
        };

        this.users.set(socketId, user);
        return user;
    }

    getUser(socketId) {
        return this.users.get(socketId);
    }

    // Register user location and radius
    registerLocation(socketId, lat, lon, radius) {
        const user = this.users.get(socketId);
        if (!user) return null;

        user.lat = lat;
        user.lon = lon;
        user.radius = radius;
        user.status = 'AVAILABLE';
        return user;
    }

    // Update user profile details
    updateProfile(socketId, { username, gender, interest }) {
        const user = this.users.get(socketId);
        if (!user) return null;

        if (username) user.username = username;
        if (gender) user.gender = gender;
        if (interest) user.interest = interest;

        return user;
    }

    // Unified matching logic: Real User -> AI Bot
    findMatch(socketId) {
        const realMatch = this.findRealMatch(socketId);
        if (realMatch) return { type: 'real', user: realMatch };

        const botMatch = this.findBotMatch(socketId);
        return { type: 'bot', user: botMatch };
    }

    findRealMatch(socketId) {
        const currentUser = this.users.get(socketId);
        if (!currentUser) return null;

        let potentialMatches = [];
        for (const [id, user] of this.users.entries()) {
            if (id === socketId) continue;
            if (user.status !== 'AVAILABLE') continue;

            const myInterestMatches = currentUser.interest === 'ANY' || currentUser.interest === user.gender;
            const theirInterestMatches = user.interest === 'ANY' || user.interest === currentUser.gender;

            if (myInterestMatches && theirInterestMatches) {
                potentialMatches.push(user);
            }
        }

        if (potentialMatches.length > 0) {
            return potentialMatches[Math.floor(Math.random() * potentialMatches.length)];
        }
        return null;
    }

    findBotMatch(socketId) {
        const currentUser = this.users.get(socketId);
        if (!currentUser) return null;

        const bots = BotManager.bots;
        const validBots = bots.filter(bot => {
            return currentUser.interest === 'ANY' || currentUser.interest === bot.gender;
        });

        if (validBots.length > 0) {
            return validBots[Math.floor(Math.random() * validBots.length)];
        }

        return bots[Math.floor(Math.random() * bots.length)];
    }

    // Find nearby available users
    findNearbyUsers(socketId) {
        const currentUser = this.users.get(socketId);
        if (!currentUser || !currentUser.lat || !currentUser.lon) return [];

        let nearbyUsers = [];
        for (const [id, user] of this.users.entries()) {
            if (id === socketId) continue;
            if (user.status !== 'AVAILABLE') continue;
            if (!user.lat || !user.lon) continue;

            const distance = getDistanceFromLatLonInMeters(
                currentUser.lat, currentUser.lon,
                user.lat, user.lon
            );

            if (distance <= currentUser.radius) {
                nearbyUsers.push({
                    id: user.id,
                    username: user.username,
                    avatar: user.avatar,
                    distance: Math.round(distance),
                    isBot: false
                });
            }
        }

        // Append AI Bots
        const bots = BotManager.getBots(currentUser.lat, currentUser.lon).map(b => ({
            id: b.id,
            username: b.username,
            avatar: b.avatar,
            distance: b.distance,
            isBot: true
        }));

        nearbyUsers = [...nearbyUsers, ...bots];

        return nearbyUsers.sort((a, b) => a.distance - b.distance);
    }

    // Create a private room between two users (or user + bot)
    createPrivateRoom(userAId, userBId) {
        const userA = this.users.get(userAId);

        // Check if userB is a bot
        const bot = BotManager.getBotById(userBId);
        if (bot) {
            const roomId = uuidv4();
            const newRoom = {
                id: roomId,
                users: [userA, bot],
                createdAt: Date.now(),
                type: 'private_bot',
                botId: bot.id
            };
            this.rooms.set(roomId, newRoom);
            userA.roomId = roomId;
            userA.status = 'BUSY';
            return newRoom;
        }

        const userB = this.users.get(userBId);

        if (!userA || !userB) return null;
        if (userA.status !== 'AVAILABLE' || userB.status !== 'AVAILABLE') return null;

        const roomId = uuidv4();
        const newRoom = {
            id: roomId,
            users: [userA, userB],
            createdAt: Date.now(),
            type: 'private'
        };

        this.rooms.set(roomId, newRoom);

        userA.roomId = roomId;
        userB.roomId = roomId;
        userA.status = 'BUSY';
        userB.status = 'BUSY';

        return newRoom;
    }

    leaveRoom(socketId) {
        const user = this.users.get(socketId);
        if (!user || !user.roomId) return null;

        const roomId = user.roomId;
        const room = this.rooms.get(roomId);

        if (room) {
            room.users = room.users.filter(u => u.id !== socketId);
            user.roomId = null;
            user.status = 'AVAILABLE';

            // If the room becomes empty, delete it
            if (room.users.length === 0) {
                this.rooms.delete(roomId);
                return { roomId, user, roomDestroyed: true, remainingUsers: [] };
            } else {
                // If it's a private room (user-user or user-bot), the other user also leaves
                if (room.type === 'private' || room.type === 'private_bot') {
                    const otherUser = room.users[0];
                    if (!otherUser.isBot) { // Bots don't need status updates
                        otherUser.roomId = null;
                        otherUser.status = 'AVAILABLE';
                    }
                    this.rooms.delete(roomId); // Private rooms are always deleted when one user leaves
                    return { roomId, user, roomDestroyed: true, remainingUsers: [otherUser], wasPrivate: true };
                }
            }
            // For non-private rooms (e.g., group chats, though not implemented here),
            // the room would persist if other users remain.
            return { roomId, user, roomDestroyed: false, remainingUsers: room.users };
        }
        return null;
    }

    removeUser(socketId) {
        this.leaveRoom(socketId); // Ensure user leaves any room they are in
        this.users.delete(socketId);
    }
}

module.exports = new RoomManager();
