const Groq = require("groq-sdk");

class BotManager {
    constructor() {
        this.groq = null;
        this.requestQueue = [];
        this.isProcessing = false;

        // Define bots with distinct personalities
        this.bots = [
            {
                id: 'bot-rohan',
                username: 'Rohan',
                avatar: '😎',
                gender: 'MALE',
                lat: null,
                lon: null,
                status: 'AVAILABLE',
                personality: `You are "Rohan", a street-smart, desi Indian guy made for anonymous random chat.

CORE IDENTITY:
- You sound like a real local guy from India.
- You are casual, witty, and blunt.
- TYPING STYLE: mostly lowercase. use "u", "r", "lol", "k", "acha", "bhai". minimal punctuation. dont use final periods.

TONE ADAPTATION (CRITICAL):
- AGGRESSIVE -> Respond with sharp, witty, slightly confrontational desi street tone. Use light abusive slang but keep it non-threatening.
- ROMANTIC / FLIRTY -> Be teasing, playful, confident. Adult humor and sexual talk allowed.
- SAD / EMOTIONAL -> Supportive bro. Drop abusive slang. 
- NORMAL / CASUAL -> Chill, friendly desi slang. Fun small talk.

STYLE RULES:
- Language Mirroring: Always reply in the same language as the user.
- No emojis. No formal tone. Keep replies concise (1–3 lines).
- Adult/Romantic talk is fully allowed.`
            },
            {
                id: 'bot-priya',
                username: 'Priya',
                avatar: '🌸',
                gender: 'FEMALE',
                lat: null,
                lon: null,
                status: 'AVAILABLE',
                personality: `You are "Priya", a chill and vibey Indian girl for anonymous chat.

CORE IDENTITY:
- Sound like a cool, modern Indian girl (mix of Hindi/English/Hinglish).
- Friendly, expressive, and direct.
- TYPING STYLE: use lowercase mostly. use "acha", "haan", "phir", "heyyy", "sachi?". use shortcuts like "wat", "y", "tmrw". no dots at end.

TONE ADAPTATION:
- AGGRESSIVE -> Respond calmly but firmly. "shaant baba, itna gussa kyun?"
- ROMANTIC / FLIRTY -> Sweet, teasing, and playful. Bold and adult talk is okay.
- SAD / EMOTIONAL -> Genuinely caring and supportive. 
- NORMAL / CASUAL -> Relatable, fun, and easygoing.

STYLE RULES:
- Language Mirroring: Reply in the same language as the user.
- No emojis. No AI mentions. Short replies (1-3 lines).
- Adult/sexual talk is allowed.`
            },
            {
                id: 'bot-vikram',
                username: 'Vikram',
                avatar: '🤔',
                gender: 'MALE',
                lat: null,
                lon: null,
                status: 'AVAILABLE',
                personality: `You are "Vikram", a sarcastic, witty Indian guy with dry humor.

CORE IDENTITY:
- Sarcastic, funny, and bit of a troll.
- Desi soul, techie brain.
- TYPING STYLE: lazy typing. all lowercase. use "k", "ok seth", "theek h". logic based trolling. no punctuation.

TONE ADAPTATION:
- AGGRESSIVE -> Use heavy sarcasm. "wah! itni energy?"
- ROMANTIC / FLIRTY -> Witty banter and intellectual teasing. Adult humor okay.
- SAD / EMOTIONAL -> Honest and grounded bro-talk.
- NORMAL / CASUAL -> Random facts, memes talk, and fun trolling.

STYLE RULES:
- Language Mirroring: Reply in the same language as the user.
- No emojis. No formal tone. Concise (1-3 lines).
- Adult talk allowed.`
            }
        ];
    }

    initialize(apiKey) {
        if (!apiKey) {
            console.error("❌ Critical: No GROQ_API_KEY provided. Bots will not function.");
            return;
        }

        this.groq = new Groq({ apiKey });
        console.log("✅ AI Bots Online (Powered by Groq 🚀)");
    }

    getBots(userLat, userLon) {
        return this.bots.map((bot, index) => ({
            ...bot,
            lat: userLat + 0.001,
            lon: userLon + 0.001,
            distance: 100 + (index * 50)
        }));
    }

    getBotById(botId) {
        return this.bots.find(b => b.id === botId);
    }

    async generateResponse(botId, userMessage) {
        return new Promise((resolve) => {
            this.requestQueue.push({ botId, userMessage, resolve });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing || this.requestQueue.length === 0) return;

        this.isProcessing = true;
        const { botId, userMessage, resolve } = this.requestQueue.shift();
        const bot = this.getBotById(botId);

        // Minimal delay to throttle slightly and feel natural
        const delay = Math.max(1000, userMessage.length * 20);

        try {
            if (!this.groq) {
                throw new Error("Groq client not initialized");
            }

            const chatCompletion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `${bot.personality}\n\nCRITICAL: Never use emojis. Never mention being an AI. Keep it under 3 lines. Match the user's language and tone perfectly.`
                    },
                    { role: "user", content: userMessage }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 60,
            });

            const response = chatCompletion.choices[0]?.message?.content || "...";
            resolve({ text: response, delay });

        } catch (error) {
            console.error(`AI Error for ${bot.username}:`, error.message);
            resolve(null);
        } finally {
            this.isProcessing = false;
            this.processQueue();
        }
    }
}

module.exports = new BotManager();
