FROM python:3.12-slim
# Install yt-dlp and Node + ffmpeg
RUN pip install --no-cache-dir yt-dlp && \
    apt-get update && apt-get install -y --no-install-recommends nodejs npm ca-certificates ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./

EXPOSE 8080
CMD ["node", "server.js"]
