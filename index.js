const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Set up view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Set up multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Routes
app.get('/', (req, res) => {
    res.render('index');
});

/**
 * Full Voice-to-Voice Pipeline:
 * 1. Sarvam STT (Audio -> Text)
 * 2. Groq LLM (Text -> Response Text)
 * 3. Sarvam TTS (Response Text -> Audio Base64)
 */
app.post('/voice-chat', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
        }

        const filePath = req.file.path;
        console.log('--- Step 1: Sarvam STT ---');

        // 1. STT
        const sttFormData = new FormData();
        sttFormData.append('file', fs.createReadStream(filePath));
        sttFormData.append('model', 'saarika:v2.5');

        const sttResponse = await axios.post('https://api.sarvam.ai/speech-to-text', sttFormData, {
            headers: {
                'api-subscription-key': process.env.SARVAM_API_KEY,
                ...sttFormData.getHeaders(),
            },
        });

        const userText = sttResponse.data.transcript || sttResponse.data.transcription;
        console.log('User said:', userText);

        if (!userText || userText.trim() === "") {
            return res.json({ transcript: "Could not understand audio", aiResponse: "I couldn't hear you clearly.", audio: null });
        }

        // 2. Groq LLM (Doctor Persona)
        console.log('--- Step 2: Groq LLM (Doctor) ---');
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `You are a professional, empathetic, and knowledgeable AI Doctor. 
                    Your goal is to listen to the patient's symptoms and provide:
                    1. A brief assessment of the condition.
                    2. A quick, safe home remedy or immediate action if applicable.
                    3. Clear instructions on what they should do next (e.g., rest, hydrate, or see a specialist).
                    
                    CRITICAL: Always keep responses concise (under 200 words) for natural speech. 
                    IMPORTANT: Maintain a professional medical tone and include a brief standard disclaimer if the situation sounds serious.
                    Respond in the same language the user speaks (English or Hindi).`
                },
                {
                    role: "user",
                    content: userText
                }
            ],
            model: "llama-3.3-70b-versatile",
        });

        const aiResponseText = chatCompletion.choices[0].message.content;
        console.log('AI response:', aiResponseText);

        // 3. Sarvam TTS
        console.log('--- Step 3: Sarvam TTS ---');
        const ttsData = {
            text: aiResponseText,
            target_language_code: "hi-IN", // Sarvam's hi-IN handles English as well
            speaker: req.body.speaker || "shubh",
            model: "bulbul:v3"
        };

        const ttsResponse = await axios.post('https://api.sarvam.ai/text-to-speech', ttsData, {
            headers: {
                'api-subscription-key': process.env.SARVAM_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        console.log('TTS Response keys:', Object.keys(ttsResponse.data));

        // Decode audio base64 from possible field names
        const audioBase64 = ttsResponse.data.audio_base64 || ttsResponse.data.audio || (ttsResponse.data.audios ? ttsResponse.data.audios[0] : null);

        // Clean up locally uploaded file
        fs.unlinkSync(filePath);

        res.json({
            transcript: userText,
            aiResponse: aiResponseText,
            audio: audioBase64
        });

    } catch (error) {
        console.error('Pipeline error:', error.response ? error.response.data : error.message);
        res.status(500).json({
            error: 'AI Voice Pipeline failed',
            details: error.response ? error.response.data : error.message
        });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
