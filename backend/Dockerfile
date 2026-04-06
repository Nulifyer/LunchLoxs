FROM golang:1.26-alpine AS base
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

FROM base AS build
RUN go build -o /server ./backend/cmd/server

FROM alpine:3
WORKDIR /app
COPY --from=build /server /server
COPY prompts /app/prompts
EXPOSE 8000
CMD ["/server"]
