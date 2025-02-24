# Use Node.js base image
FROM node:20-slim

# Install system dependencies including youtube-dl
RUN apt-get update && \
    apt-get install -y python3 ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/youtube-dl && \
    chmod a+rx /usr/local/bin/youtube-dl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create and set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Create data directory and set permissions
RUN mkdir -p /data && chmod 777 /data

# Set environment variables
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]