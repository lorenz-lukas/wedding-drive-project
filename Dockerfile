FROM node:25-alpine

WORKDIR /app
ENV NODE_ENV=production

# Copy package files
COPY --chown=node:node package*.json ./

# Install dependencies
RUN npm install --omit=dev && npm cache clean --force

# Copy application code
COPY --chown=node:node . .

# Cloud Run requer porta estar exposta
EXPOSE 3000

USER node

# Start application
CMD ["node", "server.js"]
