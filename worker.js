const { createClient } = require('@supabase/supabase-js');
const { FacebookAdsApi, Page } = require('facebook-nodejs-business-sdk');
const play = require('play-dl');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function processJob(job) {
  try {
    console.log(`Processing job ${job.id}...`);

    // Update job status to processing
    await supabase
      .from('video_promotion_queue')
      .update({ status: 'processing' })
      .eq('id', job.id);

    // Get video info
    const videoInfo = await play.video_info(job.youtube_link);
    if (!videoInfo) {
      throw new Error('Could not get video information');
    }

    // Get video stream
    const stream = await play.stream_from_info(videoInfo);
    if (!stream) {
      throw new Error('Could not get video stream');
    }

    // Initialize Facebook API
    const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      throw new Error('Facebook credentials are missing');
    }

    const api = FacebookAdsApi.init(accessToken);
    const page = new Page(pageId);

    // Prepare post content
    const postDescription = `${job.promotional_text}\n\n${
      videoInfo.video_details.description || ''
    }\n\n[ eSpazza YT Promotion by @${job.username} ]`;

    // Post to Facebook
    const response = await page.createVideo({
      description: postDescription,
      title: videoInfo.video_details.title,
      source: stream.stream,
    });

    console.log('Facebook API response:', response);

    // Update job status to completed
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

  while (true) {
    try {
      // Get the next pending job
      const { data: jobs, error } = await supabase
        .from('video_promotion_queue')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1);

      if (error) {
        console.error('Error fetching jobs:', error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      if (jobs && jobs.length > 0) {
        await processJob(jobs[0]);
      } else {
        // No jobs found, wait before checking again
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    } catch (error) {
      console.error('Worker error:', error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Start the worker
worker().catch(console.error);
