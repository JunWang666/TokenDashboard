#!/bin/sh

set -eu

if [ -n "${CI_PRIMARY_REPOSITORY_PATH:-}" ]; then
    repository_root="$CI_PRIMARY_REPOSITORY_PATH"
else
    script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    repository_root=$(CDPATH= cd -- "$script_directory/../../.." && pwd)
fi

project_path="$repository_root/iOS/TokenDashboard/TokenDashboard.xcodeproj"
scheme_path="$project_path/xcshareddata/xcschemes/TokenDashboard.xcscheme"

if [ ! -d "$project_path" ]; then
    echo "error: Xcode project not found at $project_path" >&2
    exit 1
fi

if [ ! -f "$scheme_path" ]; then
    echo "error: Shared TokenDashboard scheme not found at $scheme_path" >&2
    exit 1
fi

echo "Xcode Cloud checkout is ready: $project_path"
