# Involucro sottile sugli script npm.
#
# `make` non è installato ovunque (Windows Senza developer tools, container minimali),
# e su GitHub Actions su Linux lo è. Gli script npm sono la definizione unica: il
# Makefile non ripete nulla, chiama e basta. Se un comando esiste solo qui e non in
# package.json, è un comando che non gira in CI.
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

ci: ## esattamente quello che gira in CI
	npm run ci