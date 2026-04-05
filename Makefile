IMAGE_NAME ?= gmail-organizer-mcp

.PHONY: build test deploy

build:
	docker build --target production -t $(IMAGE_NAME) .

test:
	docker compose -f docker-compose.test.yml run --rm --build test-runner

deploy:
	./scripts/deploy.sh
