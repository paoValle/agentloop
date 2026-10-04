.DEFAULT_GOAL := help
.PHONY: help setup dev test lint typecheck ci

help: ## mostra questo aiuto
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## installa le dipendenze
	npm ci

dev: ## avvia in locale
	npm run dev

test: ## suite completa
	npm test

typecheck: ## controlla i tipi in strict mode
	npm run typecheck

lint: ## eslint, zero warning tollerati
	npm run lint

ci: typecheck lint test ## esattamente quello che gira in CI
