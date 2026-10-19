FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# web UI optional for health; copy if present at build context
COPY --from=web /dev/null /tmp/ignore 2>/dev/null || true
ENV NODE_ENV=production
ENV LINKO_HOST=0.0.0.0
EXPOSE 10000
CMD ["node", "src/index.js"]
