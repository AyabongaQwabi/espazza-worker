FROM node:20-slim

# Install system dependencies including yt-dlp and ffmpeg
RUN apt-get update && \
    apt-get install -y python3 curl ffmpeg && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /tmp/youtube-downloads && \
    chmod 777 /tmp/youtube-downloads

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Start the worker
CMD ["node", "worker.js"]