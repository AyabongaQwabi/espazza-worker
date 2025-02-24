const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const youtubeDl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');
require('dotenv').config();

const youtube = google.youtube('v3');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Utility function for delay with exponential backoff
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to extract links from text and replace them with placeholder
function extractAndReplaceLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const links = text.match(urlRegex) || [];
  const cleanText = text.replace(urlRegex, '(link in comments)');
  return { links, cleanText };
}

// Function to post comment on Facebook video
async function postFacebookComment(
  videoId,
  comment,
  accessToken,
  maxRetries = 3
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (i > 0) {
        const backoffDelay = Math.min(1000 * Math.pow(2, i), 10000);
        await delay(backoffDelay);
      }

      const response = await fetch(
        `https://graph.facebook.com/v18.0/${videoId}/comments`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: comment,
            access_token: accessToken,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Facebook API error: ${JSON.stringify(error)}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Comment attempt ${i + 1} failed:`, error);
      if (i === maxRetries - 1) throw error;
    }
  }
}

// Function to extract video ID from URL
function extractVideoId(url) {
  const regex =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regex);
  return match ? match[1] : null;
}

async function downloadVideo(youtubeLink) {
  const videoId = extractVideoId(youtubeLink);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  const videoPath = path.join(process.cwd(), `${videoId}.mp4`);

  try {
    console.log('Starting download to:', videoPath);

    // Remove existing file if it exists
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }

    // Download video using youtube-dl-exec with advanced options
    await youtubeDl(youtubeLink, {
      output: videoPath,
      format: 'best[ext=mp4]/best', // Simplified format for smaller file size
      mergeOutputFormat: 'mp4',
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language:en-US,en;q=0.5',
      ],
      noAbortOnError: true,
      bufferSize: '16K',
      maxSleepInterval: 30,
      sleepInterval: 5,
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

async function uploadToFacebook(
  videoPath,
  title,
  description,
  pageId,
  accessToken
) {
  const maxRetries = 3;
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      if (i > 0) {
        const backoffDelay = Math.min(1000 * Math.pow(2, i), 10000);
        console.log(
          `Retrying upload, attempt ${i + 1}, waiting ${backoffDelay}ms...`
        );
        await delay(backoffDelay);
      }

      // Verify file exists and is readable before upload
      const stats = await fs.promises.stat(videoPath);
      console.log('Uploading video, size:', stats.size, 'bytes');

      if (stats.size === 0) {
        throw new Error('Video file is empty');
      }

      if (stats.size > 1024 * 1024 * 1024) {
        // 1GB
        throw new Error('Video file is too large (>1GB)');
      }

      // Create form data
      const form = new FormData();
      form.append('source', fs.createReadStream(videoPath));
      form.append('title', title);
      form.append('description', description);
      form.append('access_token', accessToken);

      // Upload to Facebook
      console.log('Uploading to Facebook Graph API...');
      const response = await fetch(
        `https://graph-video.facebook.com/v18.0/${pageId}/videos`,
        {
          method: 'POST',
          body: form,
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Facebook API error: ${JSON.stringify(error)}`);
      }

      const result = await response.json();
      console.log('Facebook upload successful:', result);
      return result;
    } catch (error) {
      console.error(`Upload attempt ${i + 1} failed:`, error);
      lastError = error;

      if (i === maxRetries - 1) {
        throw new Error(
          `Facebook upload failed after ${maxRetries} attempts: ${error.message}`
        );
      }
    }
  }
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

    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      throw new Error('Facebook credentials are missing');
    }

    currentStatus = 'uploading';
    await supabase
      .from('video_promotion_queue')
      .update({ status: currentStatus })
      .eq('id', job.id);

    console.log('\nPreparing post content...');
    // Extract and replace links in the description
    const { links, cleanText } = extractAndReplaceLinks(
      job.promotional_text || ''
    );

    const postDescription = `${cleanText}\n\n\n Disclaimer: This video was shared from eSpazza Youtube Promotions by @${job.username})\nXhosa Hip Hop claims no coprights to the shared user generated content. \nFor more information, please visit the user profile on eSpazza.`;

    console.log('Post description:', postDescription);

    console.log('\nPosting to Facebook...');
    const response = await uploadToFacebook(
      videoPath,
      videoInfo.video_details.title,
      postDescription,
      pageId,
      accessToken
    );

    // Post links as comments if they exist
    if (links.length > 0) {
      console.log('Found links in description, posting as comments...');
      const linksComment = links
        .map((link, index) => `${index + 1}. ${link}`)
        .join('\n');

      try {
        await postFacebookComment(response.id, linksComment, accessToken);
        console.log('Successfully posted links as comment');
      } catch (error) {
        console.error('Failed to post links as comment:', error);
        // Don't fail the whole job if comment posting fails
      }
    }

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
