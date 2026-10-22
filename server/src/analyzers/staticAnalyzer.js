export const cleanDiff = (rawDiff) => {
  // Split the complete Git diff into separate file sections.
  // Each file's diff starts with "diff --git".
  const files = rawDiff.split('diff --git');

  // Keep only relevant files and exclude unnecessary ones.
  const validFiles = files.filter((file) => {
    // Remove empty sections created by split().
    if (!file.trim()) return false;

    // Convert to lowercase so exclusions are case-insensitive.
    const lowerFile = file.toLowerCase();

    // Ignore dependency lock files because they usually contain
    // generated dependency information, not application logic.
    if (lowerFile.includes('package-lock.json')) return false;
    if (lowerFile.includes('yarn.lock')) return false;

    // Ignore installed dependencies and generated build files.
    if (lowerFile.includes('node_modules/')) return false;
    if (lowerFile.includes('build/')) return false;

    // Ignore minified JavaScript files, which are difficult to review.
    if (lowerFile.includes('.min.js')) return false;

    // Keep the file if none of the exclusion rules matched.
    return true;
  });

  // Add the "diff --git" separator back to each retained section
  // and combine all sections into one cleaned diff string.
  return validFiles
    .map((file) => 'diff --git' + file)
    .join('\n');
};