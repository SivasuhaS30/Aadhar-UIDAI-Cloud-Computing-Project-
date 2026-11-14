FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy package definitions first for optimal layer caching
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source code
COPY src/ ./src/

# Run as non-root node user for security hardening
USER node

# Expose internal application port
EXPOSE 3000

# Docker internal healthcheck polling the stateless /health route
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Start the Aadhaar authentication microservice
CMD ["node", "src/index.js"]
