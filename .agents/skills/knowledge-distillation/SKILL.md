---
name: knowledge-distillation
description: Procedure for ingesting dense technical research papers, whitepapers, or specifications (PDF, academic papers, architecture docs) and transforming them into lossless technical references, dynamic agent skills, and actionable engineering checklists.
---

# Technical Knowledge Distillation Skill

Use this skill whenever converting dense external technical documents (PDF whitepapers, academic research papers, RFCs, architecture books) into usable agentic engineering artifacts without context pollution.

---

## 1. Core Principles

1. **Context Window Hygiene (Zero Raw Dumps):**
   - Never output multi-thousand-line raw text, OCR streams, or raw page dumps directly into the chat conversation.
   - Extract raw text into a scratch directory (`scratch/`) or intermediate files first, inspect structure via targeted Python scripts, and process in isolated stages.

2. **The 3-Tier Distillation Pipeline:**
   Every technical document must be decomposed into three distinct tiers:
   - **Tier 1 (The Full Technical Reference):** A comprehensive, lossless Markdown document in `docs/` preserving all formulas (KaTeX), tables, Mermaid architecture diagrams, and academic citations.
   - **Tier 2 (The Dynamic Agent Skill):** A lightweight procedural skill in `.agents/skills/<skill>/SKILL.md` loaded dynamically on demand. High leverage, low token overhead.
   - **Tier 3 (The Actionable Engineering Checklist):** A concrete setup plan or checklist (`docs/*-setup.md`) mapping the document's theoretical models into specific packages, tests, AST guardrails, and implementation phases.

3. **Lossless Technical Fidelity:**
   - Preserve exact mathematical formulas using KaTeX syntax (`$\mathbf{...}$` or `$$...$$`).
   - Convert conceptual diagrams and system sketches into standard GitHub-rendered Mermaid flowcharts.
   - Retain complete endnotes, literature citations, and numbered footnotes.

---

## 2. Ingestion & Extraction Runbook

### Step 1: Sandboxed Extraction
Extract raw text using a high-fidelity PDF parser (e.g., `fitz` / PyMuPDF) to a temporary scratch file:

```python
import fitz  # PyMuPDF

doc = fitz.open("research-paper.pdf")
with open("scratch/raw_text.txt", "w", encoding="utf-8") as f:
    for page_idx, page in enumerate(doc):
        f.write(f"\n--- [PAGE {page_idx + 1}] ---\n\n")
        f.write(page.get_text("text"))
```

### Step 2: Structural Analysis & Section Mapping
Inspect document structure using targeted scripts (grepping headings, tables, references) rather than dumping full text into chat:
* Identify core theses, definitions, and mental models.
* Catalog tables, figures, formulas, and citations.
* Map theoretical concepts to concrete project components.

### Step 3: Author Tier 1 — Comprehensive Reference (`docs/<topic>.md`)
* Build structured markdown with table of contents, executive summary, and deep-dive chapters.
* Transcribe tables into Markdown syntax.
* Re-implement all figures as Mermaid flowcharts (`flowchart TD` or `flowchart LR`).
* Document all references and endnotes.

### Step 4: Author Tier 2 — Dynamic Agent Skill (`.agents/skills/<name>/SKILL.md`)
* Extract operational rules, mental models, and decision heuristics into frontmatter-enabled `SKILL.md`.
* Ensure progressive disclosure: provide actionable summaries with relative links back to the Tier 1 reference for deep dives.

### Step 5: Author Tier 3 — Actionable Engineering Checklist (`docs/<topic>-setup.md`)
* Ground the theoretical principles into concrete project phases:
  - Toolchain & workspace configuration.
  - Deterministic AST linters and guardrails.
  - Testing harness & synthetic scenario builders.
  - Verification commands and handoff criteria.

---

## 3. Verification Checklist

Before considering distillation complete, verify:
- [ ] No raw text dumps polluted the conversation context.
- [ ] Tier 1 reference contains valid KaTeX math and parseable Mermaid syntax.
- [ ] Tier 2 skill is registered in `.agents/skills/` with clear triggers in description.
- [ ] Tier 3 engineering checklist has measurable checkboxes and terminal verification commands.
- [ ] All cross-references use repository-relative Markdown links (no absolute `file:///` paths).

