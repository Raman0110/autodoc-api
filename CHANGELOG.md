# Changelog

All notable changes to AutoDoc are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-11-13

### Fixed

- Use an absolute image URL so the animated CLI demo renders on npmjs.com.

## [0.3.0] - 2026-11-13

### Added

- Official OpenAPI 3.1 JSON Schema validation with additional semantic checks.
- YAML output through `--format yaml` or an `.yaml`/`.yml` output filename.
- YAML endpoints at `/openapi.yaml` in the CLI server and middleware.
- GitHub Actions coverage for Node.js 18, 20 and 22.
- Security policy and contribution guidance.
- Animated CLI demonstration.

### Changed

- Pinned the Scalar CDN asset to version 1.78.1 for reproducible documentation pages.
- Updated the development fixture dependency to Zod 4.6.7.

## [0.2.0] - 2026-11-10

### Added

- Express middleware serving Scalar, Swagger UI and ReDoc.
- Pre-generated specification support for production deployments.

## [0.1.0] - 2026-11-10

### Added

- Initial Express, TypeScript and Zod analysis engine.
- OpenAPI 3.1 generation, coverage reporting and CLI workflows.

[0.3.1]: https://github.com/Raman0110/autodoc-api/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Raman0110/autodoc-api/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Raman0110/autodoc-api/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Raman0110/autodoc-api/releases/tag/v0.1.0
