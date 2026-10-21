FROM node:alpine3.22

WORKDIR /tmp

COPY index.js server.js index.html package.json ./

EXPOSE 3000/tcp

RUN apk update && apk upgrade &&\
    apk add --no-cache ca-certificates openssl curl gcompat iproute2 coreutils bash &&\
    chmod +x index.js server.js &&\
    npm install

CMD ["node", "server.js"]
