const { createClient } = require('@supabase/supabase-js');
const { FacebookAdsApi, Page } = require('facebook-nodejs-business-sdk');
const play = require('play-dl');
const puppeteer = require('puppeteer');
require('dotenv').config();

// Configure play-dl with authentication and multiple user agents
play.setToken({
  useragent: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/122.0.0.0 Safari/537.36',
  ],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Utility function for delay with exponential backoff
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getVideoInfoWithRetry(youtubeLink, maxRetries = 5) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Exponential backoff delay
      if (i > 0) {
        const backoffDelay = Math.min(
          1000 * Math.pow(2, i) + Math.random() * 1000,
          30000
        );
        console.log(
          `Retry attempt ${i + 1}, waiting ${Math.round(
            backoffDelay / 1000
          )}s...`
        );
        await delay(backoffDelay);
      }

      const videoInfo = await play.video_info(youtubeLink);
      return videoInfo;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      lastError = error;

      // If this is a rate limit error, always retry
      if (
        error.message.includes('429') ||
        error.message.includes('Too Many Requests')
      ) {
        continue;
      }

      // If this is a bot detection error, try with Puppeteer as fallback
      if (
        (error.message.includes('bot') ||
          error.message.includes('unusual traffic')) &&
        i === maxRetries - 1
      ) {
        try {
          console.log('Attempting Puppeteer fallback...');
          return await getVideoInfoWithPuppeteer(youtubeLink);
        } catch (puppeteerError) {
          console.error('Puppeteer fallback failed:', puppeteerError.message);
          throw puppeteerError;
        }
      }

      // For other errors, if we're on the last retry, throw the error
      if (i === maxRetries - 1) {
        throw lastError;
      }
    }
  }

  throw lastError;
}

async function getVideoInfoWithPuppeteer(youtubeLink) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920x1080',
    ],
  });

  try {
    const page = await browser.newPage();

    // Randomize viewport size slightly
    await page.setViewport({
      width: 1920 + Math.floor(Math.random() * 100),
      height: 1080 + Math.floor(Math.random() * 100),
    });

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Add random delay to seem more human-like
    await page.setDefaultNavigationTimeout(30000);

    // Navigate to the YouTube video
    await page.goto(youtubeLink, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Wait for title to be visible
    await page.waitForSelector('h1.ytd-video-primary-info-renderer', {
      timeout: 10000,
    });

    // Extract video information
    const videoInfo = await page.evaluate(() => {
      const title = document
        .querySelector('h1.ytd-video-primary-info-renderer')
        ?.textContent?.trim();
      const description = document
        .querySelector('#description-inline-expander')
        ?.textContent?.trim();

      return {
        video_details: {
          title: title || '',
          description: description || '',
        },
      };
    });

    return videoInfo;
  } finally {
    await browser.close();
  }
}

async function processJob(job) {
  let currentStatus = 'preparing';

  try {
    console.log(`Processing job ${job.id}...`);

    // Update initial status to preparing instead of processing
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

    // Get video stream with retry logic
    console.log('Getting video stream...');
    const stream = await play.stream_from_info(videoInfo);

    if (!stream) {
      throw new Error('Could not get video stream');
    }

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
      source: stream.stream,
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
