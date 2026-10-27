const MAX_NEARBY_LINE_DISTANCE = 3;

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
    };
    let hunk;
    let newLineNumber = 0;

    for (const line of lines.slice(headerIndex + 1)) {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        hunk = { changedLines: new Set() };
        newLineNumber = Number(hunkMatch[1]);
        continue;
      }

      if (!hunk) continue;
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        hunk.changedLines.add(newLineNumber);
        const code = line.slice(1);
        file.changedLines.set(newLineNumber, code);
        file.lines.set(newLineNumber, { hunk, code, changed: true });
        newLineNumber += 1;
      } else if (line.startsWith(" ")) {
        file.lines.set(newLineNumber, { hunk, code: line.slice(1), changed: false });
        newLineNumber += 1;
      }
      // Removed lines do not occupy a line number in the new file.
    }

    files.set(filePath, file);
  }

  return files;
};

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

/** Keep findings anchored to a path and line represented by the supplied PR diff. */
export const validateFindingsAgainstDiff = (findings, diff) => {
  if (!Array.isArray(findings) || typeof diff !== "string") return [];
  const files = parseDiffFiles(diff);

  return findings.flatMap((finding) => {
    if (!finding || typeof finding.filePath !== "string") return [];
    const file = files.get(finding.filePath);
    if (!file) return [];

    const lineNumber = finding.lineNumber;
    if (!Number.isInteger(lineNumber) || lineNumber < 0) return [];

    const evidence = getEvidence(finding.explanation);
    if (!evidence || isContradictedUndefinedClaim(finding, file)) return [];

    const normalizedEvidence = normalizeCode(evidence);
    const evidenceLines = [...file.changedLines.entries()]
      .filter(([, code]) =>
        isExecutableLine(code) && normalizeCode(code).includes(normalizedEvidence)
      )
      .map(([number]) => number);

    // A location is reliable only when the quoted code occurs on one clear,
    // nearby added line in this exact file. Never anchor to braces/imports.
    const mappedLine = nearestLine(
      evidenceLines,
      lineNumber,
      MAX_NEARBY_LINE_DISTANCE
    );
    return mappedLine === undefined ? [] : [{ ...finding, lineNumber: mappedLine }];
  });
};
