const MAX_NEARBY_LINE_DISTANCE = 3;
export const MAX_FINDING_DIFF_CONTEXT_LINES = 15;
export const MAX_FINDING_DIFF_CONTEXT_LINE_LENGTH = 1000;

const parseDiffFiles = (diff) => {
  const files = new Map();
  const sections = diff.split(/^diff --git /m).slice(1);

  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => line.startsWith("+++ b/"));
    if (headerIndex < 0) continue;

    const filePath = lines[headerIndex].slice("+++ b/".length);
    // Quoted Git paths need C-style unescaping. Skip them safely instead of
    // guessing a path and accepting a finding for the wrong file.
    if (!filePath || filePath.startsWith('"') || filePath === "/dev/null") continue;

    const file = files.get(filePath) || {
      lines: new Map(),
      changedLines: new Map(),
      hunks: [],
    };
    let hunk;
    let oldLineNumber = 0;
    let newLineNumber = 0;

    for (const line of lines.slice(headerIndex + 1)) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        hunk = { changedLines: new Set(), diffLines: [] };
        file.hunks.push(hunk);
        oldLineNumber = Number(hunkMatch[1]);
        newLineNumber = Number(hunkMatch[3]);
        continue;
      }

      if (!hunk) continue;
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        hunk.changedLines.add(newLineNumber);
        const code = line.slice(1);
        file.changedLines.set(newLineNumber, code);
        file.lines.set(newLineNumber, { hunk, code, changed: true });
        hunk.diffLines.push({
          lineType: 'added',
          newLineNumber,
          code,
        });
        newLineNumber += 1;
      } else if (line.startsWith("-")) {
        hunk.diffLines.push({
          lineType: 'removed',
          oldLineNumber,
          code: line.slice(1),
        });
        oldLineNumber += 1;
      } else if (line.startsWith(" ")) {
        const code = line.slice(1);
        file.lines.set(newLineNumber, { hunk, code, changed: false });
        hunk.diffLines.push({
          lineType: 'context',
          oldLineNumber,
          newLineNumber,
          code,
        });
        oldLineNumber += 1;
        newLineNumber += 1;
      }
    }

    files.set(filePath, file);
  }

  return files;
};

/**
 * Extract a small, exact unified-diff window for a validated finding.
 * Unanchored findings may show uniquely matched evidence context, but no line
 * is marked as the finding target unless validation supplied that added line.
 */
const extractFindingDiffContextFromFiles = (finding, files) => {
  if (!finding || typeof finding.filePath !== 'string') return [];

  const file = files.get(finding.filePath);
  if (!file) return [];

  const evidence = getEvidence(finding.explanation);
  if (!evidence) return [];
  const normalizedEvidence = normalizeCode(evidence);
  if (!normalizedEvidence) return [];

  const evidenceLines = [...file.changedLines.entries()]
    .filter(([, code]) => isExecutableLine(code) && normalizeCode(code).includes(normalizedEvidence))
    .map(([lineNumber]) => lineNumber);
  if (evidenceLines.length === 0) return [];

  const hasValidatedTarget = Number.isInteger(finding.lineNumber) &&
    evidenceLines.includes(finding.lineNumber);
  const contextLineNumber = hasValidatedTarget
    ? finding.lineNumber
    : evidenceLines.length === 1 ? evidenceLines[0] : undefined;
  if (contextLineNumber === undefined) return [];

  const hunk = file.hunks.find((item) => item.changedLines.has(contextLineNumber));
  if (!hunk) return [];

  const targetIndex = hunk.diffLines.findIndex((line) =>
    line.lineType === 'added' && line.newLineNumber === contextLineNumber
  );
  if (targetIndex < 0) return [];

  const contextRadius = Math.floor(MAX_FINDING_DIFF_CONTEXT_LINES / 2);
  const start = Math.max(0, targetIndex - contextRadius);
  const end = Math.min(hunk.diffLines.length, start + MAX_FINDING_DIFF_CONTEXT_LINES);
  const boundedStart = Math.max(0, end - MAX_FINDING_DIFF_CONTEXT_LINES);

  return hunk.diffLines.slice(boundedStart, end).map((line) => {
    const truncated = line.code.length > MAX_FINDING_DIFF_CONTEXT_LINE_LENGTH;
    return {
      ...line,
      ...(truncated ? { code: line.code.slice(0, MAX_FINDING_DIFF_CONTEXT_LINE_LENGTH) } : {}),
      isTarget: hasValidatedTarget && line.lineType === 'added' && line.newLineNumber === finding.lineNumber,
      ...(truncated ? { truncated: true } : {}),
    };
  });
};

export const createFindingDiffContextExtractor = (diff) => {
  const files = typeof diff === 'string' ? parseDiffFiles(diff) : new Map();
  return (finding) => extractFindingDiffContextFromFiles(finding, files);
};

export const extractFindingDiffContext = (finding, diff) => (
  createFindingDiffContextExtractor(diff)(finding)
);

const nearestLine = (candidates, lineNumber, maxDistance = Infinity) => {
  let nearest;
  let distance = Infinity;
  let tied = false;

  for (const candidate of candidates) {
    const candidateDistance = Math.abs(candidate - lineNumber);
    if (candidateDistance < distance) {
      nearest = candidate;
      distance = candidateDistance;
      tied = false;
    } else if (candidateDistance === distance) {
      tied = true;
    }
  }

  return nearest !== undefined && distance <= maxDistance && !tied ? nearest : undefined;
};

const normalizeCode = (text) => text.replace(/\s+/g, " ").trim();

const getEvidence = (explanation) =>
  explanation.match(/\bEvidence:\s*`([^`]+)`/i)?.[1];

const isExecutableLine = (code) => {
  const trimmed = code.trim();
  return Boolean(
    trimmed &&
      !/^(?:\/\/|\/\*|\*|\*\/)/.test(trimmed) &&
      !/^(?:import\b|export\s*\{)/.test(trimmed) &&
      !/^[{}()[\],;]+$/.test(trimmed)
  );
};

const isContradictedUndefinedClaim = (finding, file) => {
  if (!/\b(?:undefined|not defined|unresolved)\b/i.test(finding.explanation)) {
    return false;
  }

  const identifiers = [...finding.explanation.matchAll(/`([A-Za-z_$][\w$]*)`/g)]
    .map((match) => match[1]);
  if (!identifiers.length) return false;

  const source = [...file.lines.values()].map(({ code }) => code).join("\n");
  return identifiers.some((identifier) => {
    const declaration = new RegExp(
      `\\b(?:const|let|var|function|class)\\s+${identifier.replace(/[$]/g, "\\$")}\\b`
    );
    return declaration.test(source);
  });
};

/**
 * Validate findings against added code and separate reliable inline locations
 * from supported findings that cannot be mapped to one specific added line.
 */
export const validateFindingsForReview = (findings, diff) => {
  if (!Array.isArray(findings) || typeof diff !== "string") {
    return { commentableFindings: [], unanchoredFindings: [] };
  }

  const files = parseDiffFiles(diff);
  const commentableFindings = [];
  const unanchoredFindings = [];

  findings.forEach((finding) => {
    if (!finding || typeof finding.filePath !== "string") return;
    const file = files.get(finding.filePath);
    if (!file) return;

    const lineNumber = finding.lineNumber;
    if (!Number.isInteger(lineNumber) || lineNumber < 0) return;

    const evidence = getEvidence(finding.explanation);
    if (!evidence || isContradictedUndefinedClaim(finding, file)) return;

    const normalizedEvidence = normalizeCode(evidence);
    const evidenceLines = [...file.changedLines.entries()]
      .filter(([, code]) =>
        isExecutableLine(code) && normalizeCode(code).includes(normalizedEvidence)
      )
      .map(([number]) => number);
    if (evidenceLines.length === 0) return;

    // A location is reliable only when the quoted code occurs on one clear,
    // nearby added line in this exact file. Never anchor to braces/imports.
    const mappedLine = nearestLine(
      evidenceLines,
      lineNumber,
      MAX_NEARBY_LINE_DISTANCE
    );
    if (mappedLine === undefined) {
      unanchoredFindings.push({ ...finding, lineNumber: undefined });
      return;
    }

    commentableFindings.push({ ...finding, lineNumber: mappedLine });
  });

  return { commentableFindings, unanchoredFindings };
};

/** Keep the established behavior for callers that only accept inline-safe findings. */
export const validateFindingsAgainstDiff = (findings, diff) => (
  validateFindingsForReview(findings, diff).commentableFindings
);
