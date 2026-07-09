# Container image — works on Railway, Fly.io, Cloud Run, or any Docker host.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
