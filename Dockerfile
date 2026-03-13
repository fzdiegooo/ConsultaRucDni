FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY index.js .

EXPOSE 4000

CMD ["node", "index.js"]