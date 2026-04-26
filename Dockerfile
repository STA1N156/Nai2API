FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["npm", "start"]
