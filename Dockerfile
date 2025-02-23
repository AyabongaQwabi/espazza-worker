FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install
RUN npm install -g ts-node


# Copy source code
COPY . .

# Start the worker
CMD ["npm", "start"]

