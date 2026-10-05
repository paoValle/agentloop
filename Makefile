# Thin wrapper around the npm scripts.
#
# `make` is not installed everywhere (Windows without developer tools, minimal
# containers), and on GitHub Actions on Linux it is. The npm scripts are the single
# definition: the Makefile repeats nothing, it just calls them. If a command exists
# only here and not in package.json, it is a command that does not run in CI.
.DEFAULT_GOAL := help
.PHONY: help setup dev test lint typecheck ci

help: ## show this help
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## install dependencies
	npm ci

dev: ## run locally
	npm run dev

test: ## full suite
	npm test

typecheck: ## check types in strict mode
	npm run typecheck

lint: ## eslint, zero warnings tolerated
	npm run lint

ci: ## exactly what runs in CI
	npm run ci
