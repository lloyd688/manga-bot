FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --production
COPY src/ ./src/
ENV NODE_ENV=production
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/index.js"]
