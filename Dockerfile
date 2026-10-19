FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY web /web
ENV NODE_ENV=production
ENV LINKO_HOST=0.0.0.0
ENV LINKO_WEB_ROOT=/web
EXPOSE 10000
CMD ["node", "src/index.js"]
