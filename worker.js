const { createClient } = require('@supabase/supabase-js');
const { FacebookAdsApi, Page } = require('facebook-nodejs-business-sdk');
const { google } = require('googleapis');
const youtubeDl = require('youtube-dl-exec');
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

async function getVideoInfoWithRetry(youtubeLink, maxRetries = 3) {
  let lastError;
  const videoId = extractVideoId(youtubeLink);

  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Add exponential backoff delay between retries
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

      // Get video info using YouTube Data API
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

async function downloadVideo(youtubeLink) {
  const videoId = extractVideoId(youtubeLink);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  const tempDir = path.join(process.cwd(), 'temp');

  // Create temp directory if it doesn't exist
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const videoPath = path.join(tempDir, `${videoId}.mp4`);

  try {
    // Download video with youtube-dl
    await youtubeDl(youtubeLink, {
      output: videoPath,
      format: 'best[ext=mp4]', // Get best quality MP4
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
    });

    return videoPath;
  } catch (error) {
    throw new Error(`Failed to download video: ${error.message}`);
  }
}

async function processJob(job) {
  let currentStatus = 'preparing';
  let videoPath = null;

  try {
    console.log(`Processing job ${job.id}...`);

    // Update initial status to preparing
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

    // Download video
    console.log('Downloading video...');
    videoPath = await downloadVideo(job.youtube_link);
    console.log('Video downloaded to:', videoPath);

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

    console.log('\n\nPreparing post content...');
    const postDescription = `${job.promotional_text}\n\n${
      videoInfo.video_details.description || ''
    }\n\n[ eSpazza YT Promotion by @${job.username} ]`;

    console.log('Post description:', postDescription);

    console.log('\n\nPosting to Facebook...');
    const response = await page.createVideo({
      description: postDescription,
      title: videoInfo.video_details.title,
      source: fs.createReadStream(videoPath),
    });

    console.log('Facebook API response:', response);

    // Only update to completed after successful upload
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
    // Clean up downloaded video file
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
