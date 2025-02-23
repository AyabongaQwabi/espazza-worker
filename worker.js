const { createClient } = require('@supabase/supabase-js');
const { FacebookAdsApi, Page } = require('facebook-nodejs-business-sdk');
const { google } = require('googleapis');
const ytdl = require('ytdl-core');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const youtube = google.youtube('v3');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Utility function for delay with exponential backoff
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to extract video ID from URL
function extractVideoId(url) {
  const regex =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Ensure temp directory exists with correct permissions
function ensureTempDir() {
  const tempDir = path.join('/tmp', 'youtube-downloads');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o777 });
  }
  return tempDir;
}

async function downloadVideo(youtubeLink) {
  const videoId = extractVideoId(youtubeLink);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  const tempDir = ensureTempDir();
  const videoPath = path.join(tempDir, `${videoId}.mp4`);

  try {
    console.log('Getting video info...');
    const info = await ytdl.getInfo(youtubeLink, {
      requestOptions: {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      },
    });

    // Get the highest quality format that includes both video and audio
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: 'audioandvideo',
    });

    if (!format || !format.url) {
      throw new Error('No suitable video format found');
    }

    console.log('Starting download to:', videoPath);
    console.log('Video format:', format.qualityLabel);

    // Download the video using node-fetch
    const response = await fetch(format.url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.statusText}`);
    }

    // Create write stream
    const fileStream = fs.createWriteStream(videoPath);
    await new Promise((resolve, reject) => {
      response.body.pipe(fileStream);
      response.body.on('error', reject);
      fileStream.on('finish', resolve);
    });

    // Verify file exists and is readable
    await fs.promises.access(videoPath, fs.constants.R_OK);
    const stats = await fs.promises.stat(videoPath);
    console.log('Download completed. File size:', stats.size, 'bytes');

    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    return videoPath;
  } catch (error) {
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }
    throw new Error(`Failed to download video: ${error.message}`);
  }
}

async function getVideoInfoWithRetry(youtubeLink, maxRetries = 3) {
  let lastError;
  const videoId = extractVideoId(youtubeLink);

  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  for (let i = 0; i < maxRetries; i++) {
    try {
      if (i > 0) {
        const backoffDelay = Math.min(
          1000 * Math.pow(2, i) + Math.random() * 1000,
          10000
        );
        console.log(
          `Retry attempt ${i + 1}, waiting ${Math.round(
            backoffDelay / 1000
          )}s...`
        );
        await delay(backoffDelay);
      }

      const response = await youtube.videos.list({
        key: process.env.YOUTUBE_API_KEY,
        part: ['snippet', 'contentDetails'],
        id: [videoId],
      });

      if (!response.data.items?.length) {
        throw new Error('Video not found');
      }

      const videoInfo = response.data.items[0];
      return {
        video_details: {
          title: videoInfo.snippet.title,
          description: videoInfo.snippet.description,
        },
      };
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      lastError = error;

      if (i === maxRetries - 1) {
        throw lastError;
      }
    }
  }

  throw lastError;
}

async function processJob(job) {
  let currentStatus = 'preparing';
  let videoPath = null;

  try {
    console.log(`Processing job ${job.id}...`);

    await supabase
      .from('video_promotion_queue')
      .update({ status: currentStatus })
      .eq('id', job.id);

    console.log('Getting video info...');
    const videoInfo = await getVideoInfoWithRetry(job.youtube_link);
    console.log('Video info:', videoInfo);

    if (!videoInfo) {
      throw new Error('Could not get video information');
    }

    currentStatus = 'downloading';
    await supabase
      .from('video_promotion_queue')
      .update({ status: currentStatus })
      .eq('id', job.id);

    console.log('Downloading video...');
    videoPath = await downloadVideo(job.youtube_link);
    console.log('Video downloaded to:', videoPath);

    // Verify file exists and is readable before proceeding
    await fs.promises.access(videoPath, fs.constants.R_OK);
    const stats = await fs.promises.stat(videoPath);
    console.log('Video file size:', stats.size, 'bytes');

    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      throw new Error('Facebook credentials are missing');
    }

    const api = FacebookAdsApi.init(accessToken);
    const page = new Page(pageId);

    currentStatus = 'uploading';
    await supabase
      .from('video_promotion_queue')
      .update({ status: currentStatus })
      .eq('id', job.id);

    console.log('\nPreparing post content...');
    const postDescription = `${job.promotional_text}\n\n${
      videoInfo.video_details.description || ''
    }\n\n[ eSpazza YT Promotion by @${job.username} ]`;

    console.log('Post description:', postDescription);

    console.log('\nPosting to Facebook...');
    const fileStream = fs.createReadStream(videoPath);

    // Handle stream errors
    fileStream.on('error', (error) => {
      console.error('Stream error:', error);
    });

    const response = await page.createVideo({
      description: postDescription,
      title: videoInfo.video_details.title,
      source: fileStream,
    });

    console.log('Facebook API response:', response);

    await supabase
      .from('video_promotion_queue')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        facebook_post_id: response?.id || null,
      })
      .eq('id', job.id);
  } catch (error) {
    console.error('Error processing job:', error);
    await supabase
      .from('video_promotion_queue')
      .update({
        status: 'failed',
        error: `Failed during ${currentStatus}: ${error.message}`,
        failed_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  } finally {
    if (videoPath && fs.existsSync(videoPath)) {
      try {
        fs.unlinkSync(videoPath);
        console.log('Cleaned up temporary video file');
      } catch (error) {
        console.error('Error cleaning up video file:', error);
      }
    }
  }
}

async function worker() {
  console.log('Worker started...');

  const intervalTime = 10000; // 10 seconds

  async function processPendingJobs() {
    try {
      console.log('Fetching pending jobs...');
      const { data: jobs, error } = await supabase
        .from('video_promotion_queue')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1);

      if (error) {
        console.error('Error fetching jobs:', error);
        return;
      }

      if (jobs && jobs.length > 0) {
        console.log('Found pending jobs:', jobs.length);
        await processJob(jobs[0]);
      } else {
        console.log('No pending jobs found.');
      }
    } catch (error) {
      console.error('Error processing job:', error);
    }
  }

  setInterval(async () => {
    await processPendingJobs();
  }, intervalTime);
}

worker().catch(console.error);
