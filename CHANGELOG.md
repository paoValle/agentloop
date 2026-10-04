# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
versioni [SemVer](https://semver.org/lang/it/).

## [Non rilasciato]

## [0.1.0] - 2026-10-04

Prima versione utilizzabile. Niente stabilità promossa: è un side project.

### Aggiunto
- `run()`: il ciclo agentico, con budget a prenotazione e tetto di passi
- `Budget`: prenotazione → saldo, importi interi in micro-dollari, `unlimited()`
- `ToolRegistry`: nome, descrizione, schema e unicità verificati all'ingresso
- validatore JSON Schema in un sottoinsieme dichiarato, con errori per JSON Pointer
- `ToolError`: l'unico modo intenzionale di dire qualcosa al modello (ADR 0004)
- `Trace`: eventi in sola aggiunta, JSONL, ridazione per tool sensibili, degradazione esplicita
- `replay()`: tre modalità (`full`, `live-tools`, `dry-run`) e avviso se il tool è cambiato
- `openAICompatible()`: adapter per endpoint chat compatibili con OpenAI

### Note
- Nessuna dipendenza runtime. Node ≥ 22.
- Streaming, tool paralleli e multi-provider sono fuori perimetro: vedi
  [RFC 0001](docs/rfc/0001-perimetro.md).
