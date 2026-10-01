.PHONY: test build check

test:
	npm test

build:
	npm run build

check: build test
