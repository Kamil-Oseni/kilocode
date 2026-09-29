# raya_change - Reproducible libopus build for Raya's Go media frontend.
FROM golang:1.26-bookworm AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libopus-dev libopusfile-dev libsoxr-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN GOMAXPROCS=2 CGO_ENABLED=1 go build -p 1 -trimpath -o /out/raya-mf ./cmd/raya-mf \
  && GOMAXPROCS=2 CGO_ENABLED=1 go test -p 1 -timeout 3m ./...

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libopus0 libopusfile0 libsoxr0 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/raya-mf /usr/local/bin/raya-mf
EXPOSE 7890
ENTRYPOINT ["raya-mf"]
