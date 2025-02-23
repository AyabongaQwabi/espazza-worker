const { createClient } = require('@supabase/supabase-js');
const { FacebookAdsApi, Page } = require('facebook-nodejs-business-sdk');
const play = require('play-dl');
const puppeteer = require('puppeteer');
require('dotenv').config();

// Configure play-dl with authentication
play.setToken({
  useragent: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  ],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getVideoInfoWithRetry(youtubeLink, maxRetries = 3) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Add a random delay between attempts
      if (i > 0) {
        const delay = Math.floor(Math.random() * 2000) + 1000; // Random delay between 1-3 seconds
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const videoInfo = await play.video_info(youtubeLink);
      return videoInfo;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      lastError = error;

      // If this is a bot detection error, try with Puppeteer as fallback
      if (error.message.includes('bot') && i === maxRetries - 1) {
        try {
          return await getVideoInfoWithPuppeteer(youtubeLink);
        } catch (puppeteerError) {
          console.error('Puppeteer fallback failed:', puppeteerError);
          throw puppeteerError;
        }
      }
    }
  }

  throw lastError;
}

async function getVideoInfoWithPuppeteer(youtubeLink) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Navigate to the YouTube video
    await page.goto(youtubeLink, { waitUntil: 'networkidle0' });

    // Extract video information
    const videoInfo = await page.evaluate(() => {
      const title = document.querySelector(
        'h1.ytd-video-primary-info-renderer'
      )?.textContent;
      const description = document.querySelector(
        '#description-inline-expander'
      )?.textContent;

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
  try {
    console.log(`Processing job ${job.id}...`);

    await supabase
      .from('video_promotion_queue')
      .update({ status: 'processing' })
      .eq('id', job.id);

    console.log('Getting video info...');
    const videoInfo = await getVideoInfoWithRetry(job.youtube_link);
    console.log('Video info:', videoInfo);

    if (!videoInfo) {
      throw new Error('Could not get video information');
    }

    // Get video stream with retry logic
    console.log('Getting video stream...');
    const stream = await play.stream_from_info(videoInfo);

    if (!stream) {
      throw new Error('Could not get video stream');
    }

    // Rest of your existing code...
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      throw new Error('Facebook credentials are missing');
    }

    const api = FacebookAdsApi.init(accessToken);
    const page = new Page(pageId);

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

    await supabase
      .from('video_promotion_queue')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);
  } catch (error) {
    console.error('Error processing job:', error);
    await supabase
      .from('video_promotion_queue')
      .update({
        status: 'failed',
        error: error.message,
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
