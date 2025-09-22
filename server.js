/**
 * IMAGE & VIDEO PROCESSING SERVER
 * Railway-deployable REST API for image editing and video generation
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Resend } = require('resend');

// Load environment variables
require('dotenv').config();

// API Keys (can be overridden by environment variables)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyBxpypz27uz_knaNAWXiBLvO8NieXnH80o';
const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY || 'AdgBCYQGebrpb8AnYGKLtFRDFff89py4';
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY || 'PHDGdrdbrDehkghamga4nk84dEmtnrP3';

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Storage for job status
const jobs = new Map();

// Deployment version for verification
const DEPLOYMENT_VERSION = '2.0.1-FORCE-UPDATE-' + new Date().toISOString();
console.log('Server starting with version:', DEPLOYMENT_VERSION);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
const resultsDir = path.join(__dirname, 'results');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ============================================
// NANO BANANA IMAGE EDITOR CLASS
// ============================================
class ImageEditor {
  constructor() {
    this.apiKey = GEMINI_API_KEY;
    // Using Gemini 2.5 Flash Image (nano-banana) for image generation
    this.endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent';
  }

  async editImage(imageBase64, prompt) {
    console.log('=== EDIT IMAGE DEBUG START ===');
    console.log('Prompt:', prompt);
    console.log('Input image base64 length:', imageBase64.length);
    console.log('Input image first 100 chars:', imageBase64.substring(0, 100));

    const requestBody = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: "image/png",
              data: imageBase64
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.9,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192
      }
    };

    console.log('Request body size:', JSON.stringify(requestBody).length);

    try {
      console.log('Calling Gemini API:', this.endpoint);
      const response = await fetch(`${this.endpoint}?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      console.log('Response status:', response.status);
      console.log('Response headers:', response.headers.raw());

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Gemini API error response:', errorText);
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log('API Response structure:', JSON.stringify(result, null, 2).substring(0, 500));

      // Extract generated image from response
      if (result.candidates?.[0]?.content?.parts) {
        console.log('Found candidates with parts, checking for images...');
        console.log('Number of parts:', result.candidates[0].content.parts.length);

        for (let i = 0; i < result.candidates[0].content.parts.length; i++) {
          const part = result.candidates[0].content.parts[i];
          console.log(`Part ${i} type:`, Object.keys(part));

          if (part.inline_data) {
            console.log('Found inline_data in part', i);
            console.log('Image mime_type:', part.inline_data.mime_type);
            console.log('Image data length:', part.inline_data.data ? part.inline_data.data.length : 0);
            console.log('Image data first 100 chars:', part.inline_data.data ? part.inline_data.data.substring(0, 100) : 'NO DATA');

            return {
              success: true,
              imageBase64: part.inline_data.data,
              message: 'Image successfully generated with Gemini 2.5 Flash Image'
            };
          }

          if (part.text) {
            console.log(`Part ${i} is text:`, part.text.substring(0, 200));
          }
        }
      }

      // Fallback to original if no image generated
      console.log('WARNING: No image in Gemini response, using original image');
      console.log('Full response for debugging:', JSON.stringify(result));
      return {
        success: true,
        imageBase64: imageBase64,
        message: 'Using original image (Gemini did not return an image)'
      };

    } catch (error) {
      console.error('=== GEMINI GENERATION ERROR ===');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      return {
        success: false,
        imageBase64: imageBase64,
        error: error.message
      };
    } finally {
      console.log('=== EDIT IMAGE DEBUG END ===');
    }
  }

  async generateVariations(imageBase64, basePrompt, count = 3) {
    const variations = [];
    
    // Define variation prompts for hardscape transformations
    const prompts = [
      `Transform this outdoor space: ${basePrompt}. Add luxury stone pavers, modern outdoor furniture, and ambient lighting. Golden hour lighting.`,
      `Transform this outdoor space: ${basePrompt}. Add a fire pit area, comfortable seating, and premium hardscaping with natural stone. Evening atmosphere.`,
      `Transform this outdoor space: ${basePrompt}. Create a modern minimalist design with clean lines, water features, and high-end materials.`
    ];

    for (let i = 0; i < count; i++) {
      console.log(`Generating variation ${i + 1}...`);
      const result = await this.editImage(imageBase64, prompts[i]);
      
      variations.push({
        id: `var_${i + 1}`,
        prompt: prompts[i],
        success: result.success,
        imageBase64: result.imageBase64 || imageBase64,
        message: result.message || result.error
      });

      // Add delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return variations;
  }
}

// ============================================
// KLING VIDEO GENERATOR CLASS
// ============================================
class VideoGenerator {
  constructor() {
    this.accessKey = KLING_ACCESS_KEY;
    this.secretKey = KLING_SECRET_KEY;
    this.baseUrl = 'https://api-singapore.klingai.com';
  }

  generateJWT() {
    const now = Math.floor(Date.now() / 1000);
    
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      iss: this.accessKey,
      sub: this.accessKey,
      aud: 'kling-api',
      exp: now + 3600,
      nbf: now,
      iat: now,
      jti: crypto.randomBytes(16).toString('hex'),
      access_key: this.accessKey
    };

    const headerBase64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(`${headerBase64}.${payloadBase64}`)
      .digest('base64url');

    return `${headerBase64}.${payloadBase64}.${signature}`;
  }

  async createVideo(imageBase64, prompt, options = {}) {
    const jwt = this.generateJWT();
    
    const requestBody = {
      model_name: options.model || 'kling-v2-1',
      mode: 'pro',
      duration: String(options.duration || 10),
      image: imageBase64,
      prompt: prompt,
      cfg_scale: 0.7,
      negative_prompt: ''
    };

    try {
      const response = await fetch(`${this.baseUrl}/v1/videos/image2video`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();
      
      if (response.ok && data.code === 0) {
        return {
          success: true,
          taskId: data.data.task_id,
          status: data.data.task_status
        };
      } else {
        throw new Error(data.message || 'Failed to create video');
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkStatus(taskId) {
    const jwt = this.generateJWT();
    
    try {
      const response = await fetch(`${this.baseUrl}/v1/videos/image2video/${taskId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      
      if (response.ok && data.code === 0) {
        const result = {
          success: true,
          status: data.data.task_status,
          statusMessage: data.data.task_status_msg
        };

        if (data.data.task_status === 'succeed' && data.data.task_result) {
          const video = data.data.task_result.videos[0];
          result.videoUrl = video.url;
          result.duration = video.duration;
        }

        return result;
      }
    } catch (error) {
      console.error('Status check error:', error);
    }

    return { success: false, status: 'error' };
  }

  async waitForVideo(taskId, jobId, updateCallback) {
    const maxAttempts = 180;
    const pollInterval = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) {
        await new Promise(r => setTimeout(r, pollInterval));
      }

      const status = await this.checkStatus(taskId);
      
      if (updateCallback) {
        const progress = Math.min((i * 5 / 600) * 100, 99);
        updateCallback(status.status, progress);
      }

      if (status.status === 'succeed') {
        return status;
      } else if (status.status === 'failed') {
        throw new Error(status.statusMessage || 'Video generation failed');
      }
    }

    throw new Error('Timeout waiting for video');
  }
}

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: DEPLOYMENT_VERSION,
    endpoints: [
      'POST /process - Upload image for processing',
      'GET /status/:jobId - Check job status',
      'GET /result/:jobId - Get processing results'
    ]
  });
});

// Version endpoint for deployment verification
app.get('/version', (req, res) => {
  res.json({
    version: DEPLOYMENT_VERSION,
    deployed: new Date().toISOString(),
    status: 'ACTIVE',
    changes: [
      'Changed "Creating Your Dream Garden" to "Creating Your Dream Space"',
      'Added regenerate button functionality',
      'Removed "100% Free to Try" text',
      'Fixed email functionality with Resend API'
    ]
  });
});

// Main processing endpoint
app.post('/process', upload.single('image'), async (req, res) => {
  console.log('=== PROCESS ENDPOINT DEBUG ===');
  console.log('Request received at /process');

  try {
    const jobId = uuidv4();
    console.log('Job ID:', jobId);

    // Validate input
    if (!req.file) {
      console.error('ERROR: No file uploaded');
      return res.status(400).json({ error: 'No image uploaded' });
    }

    console.log('File received:');
    console.log('- Original name:', req.file.originalname);
    console.log('- Mimetype:', req.file.mimetype);
    console.log('- Size:', req.file.size, 'bytes');

    const { prompt = 'Transform into luxury outdoor living space', generateVideos = true } = req.body;
    console.log('Prompt:', prompt);
    console.log('Generate videos:', generateVideos);

    // Convert image to base64
    const imageBase64 = req.file.buffer.toString('base64');
    console.log('Base64 conversion complete, length:', imageBase64.length);
    console.log('Base64 first 100 chars:', imageBase64.substring(0, 100));

    // Initialize job
    const job = {
      id: jobId,
      status: 'processing',
      stage: 'generating_variations',
      progress: 0,
      createdAt: new Date().toISOString(),
      prompt,
      generateVideos: generateVideos === 'true' || generateVideos === true,
      variations: [],
      videos: []
    };
    
    jobs.set(jobId, job);

    // Start async processing
    processJob(jobId, imageBase64, prompt, job.generateVideos);

    // Return job ID immediately
    res.json({
      success: true,
      jobId,
      message: 'Processing started',
      checkStatus: `/status/${jobId}`,
      getResults: `/result/${jobId}`
    });

  } catch (error) {
    console.error('Process error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Status check endpoint
app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    variations: job.variations.length,
    videos: job.videos.length
  });
});

// Results endpoint
app.get('/result/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'completed' && job.status !== 'failed') {
    return res.json({
      jobId,
      status: job.status,
      message: 'Still processing, check back later'
    });
  }

  res.json({
    jobId,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    variations: job.variations.map(v => ({
      id: v.id,
      prompt: v.prompt,
      imageUrl: v.imageUrl,
      success: v.success
    })),
    videos: job.videos.map(v => ({
      id: v.id,
      variationId: v.variationId,
      videoUrl: v.videoUrl,
      duration: v.duration,
      status: v.status
    })),
    error: job.error
  });
});

// Async job processor
async function processJob(jobId, imageBase64, prompt, generateVideos) {
  const job = jobs.get(jobId);
  const editor = new ImageEditor();
  const videoGen = new VideoGenerator();

  try {
    // Step 1: Generate image variations
    console.log(`[${jobId}] Generating variations...`);
    job.stage = 'generating_variations';
    job.progress = 10;

    const variations = await editor.generateVariations(imageBase64, prompt, 3);
    
    // Save variations
    console.log('=== SAVING VARIATIONS DEBUG ===');
    for (const variation of variations) {
      console.log(`Saving variation ${variation.id}...`);
      console.log('Image base64 length:', variation.imageBase64 ? variation.imageBase64.length : 0);
      console.log('Success status:', variation.success);
      console.log('Message:', variation.message);

      try {
        // Check if base64 is valid
        if (!variation.imageBase64 || variation.imageBase64.length === 0) {
          console.error('ERROR: Empty base64 for variation', variation.id);
          variation.imageUrl = '/images/placeholder.png';
          job.variations.push(variation);
          continue;
        }

        const imageBuffer = Buffer.from(variation.imageBase64, 'base64');
        console.log('Buffer size:', imageBuffer.length, 'bytes');

        const imagePath = path.join(resultsDir, `${jobId}_${variation.id}.png`);
        fs.writeFileSync(imagePath, imageBuffer);
        console.log('Saved to:', imagePath);

        // Verify file was written
        const stats = fs.statSync(imagePath);
        console.log('File size on disk:', stats.size, 'bytes');

        variation.imageUrl = `/results/${jobId}_${variation.id}.png`;
        job.variations.push(variation);
      } catch (saveError) {
        console.error('ERROR saving variation', variation.id, ':', saveError);
        variation.imageUrl = '/images/placeholder.png';
        job.variations.push(variation);
      }
    }
    console.log('=== VARIATIONS SAVED ===');

    job.progress = 40;

    // Step 2: Generate videos if requested
    if (generateVideos) {
      console.log(`[${jobId}] Creating videos...`);
      job.stage = 'generating_videos';
      
      const videoPrompt = 'Cinematic camera movement, slow dolly in, professional real estate showcase';
      
      for (let i = 0; i < variations.length; i++) {
        const variation = variations[i];
        job.progress = 40 + (i * 20);
        
        console.log(`[${jobId}] Creating video for variation ${i + 1}...`);
        
        const videoTask = await videoGen.createVideo(variation.imageBase64, videoPrompt);
        
        if (videoTask.success) {
          const videoJob = {
            id: `video_${i + 1}`,
            variationId: variation.id,
            taskId: videoTask.taskId,
            status: 'processing'
          };
          
          job.videos.push(videoJob);
          
          // Wait for video completion
          try {
            const result = await videoGen.waitForVideo(
              videoTask.taskId,
              jobId,
              (status, progress) => {
                videoJob.status = status;
                job.progress = Math.min(40 + (i * 20) + (progress * 0.2), 95);
              }
            );
            
            if (result.success && result.videoUrl) {
              videoJob.videoUrl = result.videoUrl;
              videoJob.duration = result.duration;
              videoJob.status = 'completed';
            }
          } catch (error) {
            videoJob.status = 'failed';
            videoJob.error = error.message;
          }
        }
        
        // Add delay between video generations
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Mark as completed
    job.status = 'completed';
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    console.log(`[${jobId}] Processing completed`);

  } catch (error) {
    console.error(`[${jobId}] Processing failed:`, error);
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
  }
}

// Serve static files from current directory (HTML, CSS, JS)
app.use(express.static(__dirname));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve static files from results directory
app.use('/results', express.static(resultsDir));

// Polyfill for Headers if not available (for older Node versions)
if (typeof Headers === 'undefined') {
  global.Headers = class Headers {
    constructor(init) {
      this.headers = {};
      if (init) {
        Object.entries(init).forEach(([key, value]) => {
          this.headers[key.toLowerCase()] = value;
        });
      }
    }
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
    get(name) {
      return this.headers[name.toLowerCase()];
    }
  };
}

// Email configuration with Resend - initialize lazily to avoid startup errors
let resendInstance = null;
const getResend = () => {
  if (!resendInstance) {
    const { Resend } = require('resend');
    resendInstance = new Resend(process.env.RESEND_API_KEY || 're_MB73pTWk_G8cvGuMMFWifocUcKFjq8eau');
  }
  return resendInstance;
};

// Send email endpoint
app.post('/send-email', async (req, res) => {
  const { name, email, phone, designImage, type } = req.body;

  try {
    const resend = getResend();
    // HTML email template
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
          .logo { font-size: 28px; font-weight: bold; margin-bottom: 10px; }
          .content { padding: 30px; }
          .design-image { width: 100%; max-width: 500px; height: auto; border-radius: 8px; margin: 20px 0; }
          .info-box { background-color: #f8f9fa; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; }
          .cta-button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; margin: 20px 0; }
          .footer { background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">🏡 AI Hardscape Designer</div>
            <p>Your Dream Space Design is Ready!</p>
          </div>
          <div class="content">
            <h2>Hello ${name},</h2>
            <p>Thank you for using our AI Hardscape Designer! Your transformed outdoor space design has been generated and is attached below.</p>

            ${designImage ? `<img src="${designImage}" alt="Your Design" class="design-image">` : ''}

            <div class="info-box">
              <h3>Your Information:</h3>
              <p><strong>Name:</strong> ${name}</p>
              <p><strong>Email:</strong> ${email}</p>
              <p><strong>Phone:</strong> ${phone}</p>
            </div>

            <p><strong>Ready to bring this design to life?</strong></p>
            <p>Reply to this email to schedule a free consultation with our design experts. We'll discuss:</p>
            <ul>
              <li>Customization options for your specific space</li>
              <li>Material selection and pricing</li>
              <li>Installation timeline</li>
              <li>Financing options available</li>
            </ul>

            <center>
              <a href="https://calendly.com/your-calendar/consultation" class="cta-button">Schedule Free Consultation</a>
            </center>

            <p>Have questions? Simply reply to this email and our team will get back to you within 24 hours.</p>

            <p>Best regards,<br>
            The AI Hardscape Designer Team</p>
          </div>
          <div class="footer">
            <p>© 2024 AI Hardscape Designer. All rights reserved.</p>
            <p>This email was sent because you requested a ${type === 'quote' ? 'quote' : 'design download'} on our website.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Send email with Resend
    const emailData = await resend.emails.send({
      from: 'AI Hardscape Designer <onboarding@resend.dev>',
      to: [email],
      cc: ['alessandro@isthispossible.ai'], // Copy to admin
      subject: type === 'quote' ? '🏡 Your Hardscape Design Quote Request' : '🏡 Your Hardscape Design is Ready!',
      html: htmlContent
    });

    console.log('Email sent successfully to:', email);
    res.json({ success: true, message: 'Email sent successfully' });

  } catch (error) {
    console.error('Email sending failed:', error);
    res.status(500).json({ success: false, error: 'Failed to send email' });
  }
});

// Webhook endpoint for lead capture (backup)
app.post('/webhook/lead-capture', async (req, res) => {
  const leadData = req.body;

  // Log the lead data
  console.log('Lead captured:', leadData);

  // Store to file as backup
  const leadsFile = path.join(__dirname, 'leads.json');
  let leads = [];

  try {
    if (fs.existsSync(leadsFile)) {
      leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    }
  } catch (error) {
    console.error('Error reading leads file:', error);
  }

  leads.push({
    ...leadData,
    capturedAt: new Date().toISOString()
  });

  fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));

  // Try to send email notification with Resend
  try {
    await resend.emails.send({
      from: 'AI Hardscape Designer <onboarding@resend.dev>',
      to: ['alessandro@isthispossible.ai'],
      subject: `New ${leadData.type} Lead: ${leadData.name}`,
      html: `
        <h3>New Lead Captured</h3>
        <p><strong>Type:</strong> ${leadData.type}</p>
        <p><strong>Name:</strong> ${leadData.name}</p>
        <p><strong>Email:</strong> ${leadData.email}</p>
        <p><strong>Phone:</strong> ${leadData.phone}</p>
        <p><strong>Timestamp:</strong> ${leadData.timestamp}</p>
      `
    });
  } catch (error) {
    console.error('Failed to send lead notification:', error);
  }

  res.json({ success: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Image & Video Processor Server`);
  console.log(`📡 Running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log('\nEndpoints:');
  console.log('  POST /process - Upload image for processing');
  console.log('  GET /status/:jobId - Check job status');
  console.log('  GET /result/:jobId - Get processing results');
});

module.exports = app;