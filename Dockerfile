# Use Node.js 20 stable runtime
FROM node:20-slim

# Set working directory inside container
WORKDIR /app

# Copy dependencies manifest
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source files
COPY . .

# Create uploads directory and set permissions
RUN mkdir -p uploads && chmod 777 uploads

# Expose port 3000
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
