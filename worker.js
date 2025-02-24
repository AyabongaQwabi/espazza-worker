const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const youtubeDl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');
require('dotenv').config();

const youtube = google.youtube('v3');

console.log('Initializing worker with Supabase configuration...');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Utility function for delay with exponential backoff
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to extract links from text and replace them with placeholder
function extractAndReplaceLinks(text) {
  console.log('Extracting links from text...');
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const links = text.match(urlRegex) || [];
  const cleanText = text.replace(urlRegex, '(link in comments)');
  console.log(`Found ${links.length} links in text`);
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
        console.log(
          `Retrying comment post, attempt ${
            i + 1
          }, waiting ${backoffDelay}ms...`
        );
        await delay(backoffDelay);
      }

      console.log(`Posting comment to Facebook video ${videoId}...`);
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

      console.log('Successfully posted comment to Facebook');
      return await response.json();
    } catch (error) {
      console.error(`Comment attempt ${i + 1} failed:`, error);
      if (i === maxRetries - 1) throw error;
    }
  }
}

// Function to extract video ID from URL
function extractVideoId(url) {
  console.log('Extracting video ID from URL:', url);
  const regex =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regex);
  if (match) {
    console.log('Successfully extracted video ID:', match[1]);
    return match[1];
  }
  console.log('Failed to extract video ID from URL');
  return null;
}

async function downloadVideo(youtubeLink) {
  console.log('\n=== Starting Video Download Process ===');
  const videoId = extractVideoId(youtubeLink);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  // Use /data directory for temporary files
  const videoPath = path.join('/data', `${videoId}.mp4`);
  console.log('Video will be downloaded to:', videoPath);

  try {
    console.log('Checking for existing video file...');
    // Remove existing file if it exists
    if (fs.existsSync(videoPath)) {
      console.log('Found existing video file, removing...');
      fs.unlinkSync(videoPath);
      console.log('Existing video file removed');
    }

    // Ensure /data directory exists and is writable
    console.log('Verifying /data directory access...');
    try {
      await fs.promises.access('/data', fs.constants.W_OK);
      console.log('/data directory is accessible and writable');
    } catch (error) {
      console.error('Error accessing /data directory:', error);
      throw new Error('Cannot access /data directory');
    }

    console.log('Configuring youtube-dl options...');
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

    console.log('Download completed, verifying file...');
    // Verify file exists and is readable
    await fs.promises.access(videoPath, fs.constants.R_OK);
    const stats = await fs.promises.stat(videoPath);
    console.log('Video file details:');
    console.log('- Size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('- Created:', stats.birthtime);
    console.log('- Last modified:', stats.mtime);

    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    console.log('=== Video Download Process Completed Successfully ===\n');
    return videoPath;
  } catch (error) {
    console.error('=== Video Download Process Failed ===');
    console.error('Error details:', error);
    if (fs.existsSync(videoPath)) {
      console.log('Cleaning up failed download file...');
      fs.unlinkSync(videoPath);
      console.log('Failed download file removed');
    }
    throw new Error(`Failed to download video: ${error.message}`);
  }
}

async function getVideoInfoWithRetry(youtubeLink, maxRetries = 3) {
  console.log('\n=== Starting Video Info Retrieval ===');
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

      console.log('Fetching video details from YouTube API...');
      const response = await youtube.videos.list({
        key: process.env.YOUTUBE_API_KEY,
        part: ['snippet', 'contentDetails'],
        id: [videoId],
      });

      if (!response.data.items?.length) {
        console.log('No video found with ID:', videoId);
        throw new Error('Video not found');
      }

      const videoInfo = response.data.items[0];
      console.log('Successfully retrieved video information:');
      console.log('- Title:', videoInfo.snippet.title);
      console.log(
        '- Description length:',
        videoInfo.snippet.description.length,
        'characters'
      );
      console.log('=== Video Info Retrieval Completed ===\n');

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
        console.error('=== Video Info Retrieval Failed ===');
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
  console.log('\n=== Starting Facebook Upload Process ===');
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

      console.log('Verifying video file before upload...');
      // Verify file exists and is readable before upload
      const stats = await fs.promises.stat(videoPath);
      console.log('Video file details for upload:');
      console.log('- Size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
      console.log('- Path:', videoPath);

      if (stats.size === 0) {
        throw new Error('Video file is empty');
      }

      if (stats.size > 1024 * 1024 * 1024) {
        // 1GB
        throw new Error('Video file is too large (>1GB)');
      }

      console.log('Preparing form data for upload...');
      // Create form data
      const form = new FormData();
      form.append('source', fs.createReadStream(videoPath));
      form.append('title', title);
      form.append('description', description);
      form.append('access_token', accessToken);

      console.log('Uploading to Facebook Graph API...');
      console.log('- Title length:', title.length, 'characters');
      console.log('- Description length:', description.length, 'characters');

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
      console.log('Facebook upload successful!');
      console.log('- Video ID:', result.id);
      console.log('=== Facebook Upload Process Completed ===\n');
      return result;
    } catch (error) {
      console.error(`Upload attempt ${i + 1} failed:`, error);
      lastError = error;

      if (i === maxRetries - 1) {
        console.error('=== Facebook Upload Process Failed ===');
        throw new Error(
          `Facebook upload failed after ${maxRetries} attempts: ${error.message}`
        );
      }
    }
  }
}

async function processJob(job) {
  console.log('\n========================================');
  console.log(`Starting job processing for ID: ${job.id}`);
  console.log('========================================\n');

  let currentStatus = 'preparing';
  let videoPath = null;

  try {
    console.log(`Updating job status to: ${currentStatus}`);
    await supabase
      .from('video_promotion_queue')
      .update({ status: currentStatus })
      .eq('id', job.id);

    console.log('\nFetching video information...');
    const videoInfo = await getVideoInfoWithRetry(job.youtube_link);
    console.log('Successfully retrieved video information');

    if (!videoInfo) {
      throw new Error('Could not get video information');
    }

    currentStatus = 'downloading';
    console.log(`\nUpdating job status to: ${currentStatus}`);
    await supabase
      .from('video_promotion_queue')
      .update({ status: currentStatus })
      .eq('id', job.id);

    console.log('\nStarting video download...');
    videoPath = await downloadVideo(job.youtube_link);
    console.log('Video successfully downloaded to:', videoPath);

    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      throw new Error('Facebook credentials are missing');
    }

    currentStatus = 'uploading';
    console.log(`\nUpdating job status to: ${currentStatus}`);
    await supabase
      .from('video_promotion_queue')
      .update({ status: currentStatus })
      .eq('id', job.id);

    console.log('\nPreparing post content...');
    // Extract and replace links in the description
    const { links, cleanText } = extractAndReplaceLinks(
      videoInfo.video_details.description || ''
    );

    const postDescription = `${job.promotional_text}\n\n${cleanText}\n\n[ eSpazza YT Promotion by @${job.username} ]`;

    console.log('Post content prepared:');
    console.log('- Description length:', postDescription.length, 'characters');
    console.log('- Number of links extracted:', links.length);

    console.log('\nUploading to Facebook...');
    const response = await uploadToFacebook(
      videoPath,
      videoInfo.video_details.title,
      postDescription,
      pageId,
      accessToken
    );

    // Post links as comments if they exist
    if (links.length > 0) {
      console.log('\nPosting links as comments...');
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

    console.log('\nUpdating job status to completed...');
    await supabase
      .from('video_promotion_queue')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        facebook_post_id: response?.id || null,
      })
      .eq('id', job.id);

    console.log('\n=== Job Processing Completed Successfully ===');
    console.log(`Job ID: ${job.id}`);
    console.log(`Facebook Post ID: ${response?.id}`);
    console.log('==========================================\n');
  } catch (error) {
    console.error('\n=== Job Processing Failed ===');
    console.error(`Job ID: ${job.id}`);
    console.error(`Failed during: ${currentStatus}`);
    console.error('Error:', error);
    console.error('===============================\n');

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
        console.log('Cleaning up temporary video file...');
        fs.unlinkSync(videoPath);
        console.log('Temporary video file removed successfully');
      } catch (error) {
        console.error('Error cleaning up video file:', error);
      }
    }
  }
}

async function worker() {
  console.log('\n===========================================');
  console.log('Worker service starting...');
  console.log('===========================================\n');

  try {
    const files = fs.readdirSync(process.cwd());
    console.log('Directory contents:', files);
  } catch (error) {
    console.error('Error listing directory:', error);
  }

  // Test file creation
  try {
    fs.writeFileSync('myfile.txt', 'test');
    console.log('Successfully created myfile.txt');

    // Verify file exists
    if (fs.existsSync('myfile.txt')) {
      console.log('Verified myfile.txt exists');
    }
  } catch (error) {
    console.error('Error creating test file:', error);
  }
  const intervalTime = 10000; // 10 seconds

  async function processPendingJobs() {
    try {
      console.log('\nChecking for pending jobs...');
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
        console.log(`Found ${jobs.length} pending job(s)`);
        console.log('Processing job ID:', jobs[0].id);
        await processJob(jobs[0]);
      } else {
        console.log('No pending jobs found');
      }
    } catch (error) {
      console.error('Error in job processing cycle:', error);
    }
  }

  console.log(`Setting up job processing interval: ${intervalTime}ms`);
  setInterval(async () => {
    await processPendingJobs();
  }, intervalTime);

  console.log('Worker service initialized and running...\n');
}

worker().catch(console.error);
