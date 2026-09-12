#!/usr/bin/env ruby

require "fileutils"
require "xcodeproj"

root = File.expand_path(__dir__)
project_path = File.join(root, "contextos-desktop.xcodeproj")
FileUtils.rm_rf(project_path)

project = Xcodeproj::Project.new(project_path)
project.root_object.attributes["LastUpgradeCheck"] = "2600"
project.root_object.compatibility_version = "Xcode 3.2"
project.root_object.development_region = "en"
project.root_object.known_regions = ["en", "Base"]

target = project.new_target(:application, "contextos-desktop", :osx, "14.0")
target.product_name = "contextos"

sources_group = project.main_group.new_group("Sources", "Sources")
app_group = sources_group.new_group("ContextOSDesktop", "ContextOSDesktop")
sqlite_group = sources_group.new_group("CSQLite", "CSQLite")
resources_group = project.main_group.new_group("Resources", "Resources")

swift_files = Dir[File.join(root, "Sources", "ContextOSDesktop", "*.swift")].sort
swift_files.each do |path|
  target.add_file_references([app_group.new_file(path)])
end

module_map = sqlite_group.new_file(File.join(root, "Sources", "CSQLite", "module.modulemap"))
shim_header = sqlite_group.new_file(File.join(root, "Sources", "CSQLite", "shim.h"))

app_icon = resources_group.new_file(File.join(root, "Resources", "AppIcon.icns"))
target.resources_build_phase.add_file_reference(app_icon)

plugin_phase = target.new_shell_script_build_phase("Embed contextos Codex plugin")
plugin_phase.shell_script = <<~'SCRIPT'
  set -eu
  marketplace_root="${BUILT_PRODUCTS_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/MarketplaceRoot"
  mkdir -p "${marketplace_root}/plugins" "${marketplace_root}/.agents/plugins"
  /usr/bin/rsync -a "${SRCROOT}/../../plugins/contextos/" "${marketplace_root}/plugins/contextos/"
  /usr/bin/rsync -a "${SRCROOT}/../../.agents/plugins/" "${marketplace_root}/.agents/plugins/"
SCRIPT
plugin_phase.run_only_for_deployment_postprocessing = false
plugin_phase.output_paths = [
  "$(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/MarketplaceRoot/.agents/plugins/marketplace.json",
]

common_settings = {
  "PRODUCT_BUNDLE_IDENTIFIER" => "com.contextos.desktop",
  "PRODUCT_NAME" => "contextos",
  "INFOPLIST_FILE" => "Resources/Info.plist",
  "GENERATE_INFOPLIST_FILE" => "NO",
  "MACOSX_DEPLOYMENT_TARGET" => "14.0",
  "SWIFT_VERSION" => "5.0",
  "CLANG_ENABLE_MODULES" => "YES",
  "SWIFT_INCLUDE_PATHS" => "$(SRCROOT)/Sources/CSQLite",
  "HEADER_SEARCH_PATHS" => "$(SRCROOT)/Sources/CSQLite",
  "OTHER_LDFLAGS" => ["$(inherited)", "-lsqlite3"],
  "LD_RUNPATH_SEARCH_PATHS" => ["$(inherited)", "@executable_path/../Frameworks"],
  "ARCHS" => "arm64 x86_64",
  "ONLY_ACTIVE_ARCH" => "NO",
  "SUPPORTED_PLATFORMS" => "macosx",
  "CODE_SIGN_STYLE" => "Manual",
  "DEVELOPMENT_TEAM" => "4QAVDJK7PA",
  "CODE_SIGN_IDENTITY[sdk=macosx*]" => "Developer ID Application: binbin yu (4QAVDJK7PA)",
  "CODE_SIGN_INJECT_BASE_ENTITLEMENTS" => "NO",
  "ENABLE_HARDENED_RUNTIME" => "YES",
  "ASSETCATALOG_COMPILER_APPICON_NAME" => "",
}

target.build_configurations.each do |configuration|
  configuration.build_settings.update(common_settings)
  configuration.build_settings["SWIFT_OBJC_BRIDGING_HEADER"] = ""
end

target.build_configurations.find { |config| config.name == "Debug" }.build_settings.update(
  "SWIFT_OPTIMIZATION_LEVEL" => "-Onone",
  "GCC_PREPROCESSOR_DEFINITIONS" => ["$(inherited)", "DEBUG=1"],
)

target.build_configurations.find { |config| config.name == "Release" }.build_settings.update(
  "SWIFT_OPTIMIZATION_LEVEL" => "-O",
  "SWIFT_COMPILATION_MODE" => "wholemodule",
)

project.build_configurations.each do |configuration|
  configuration.build_settings["MACOSX_DEPLOYMENT_TARGET"] = "14.0"
end

scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(target, nil, launch_target: true)
scheme.archive_action = Xcodeproj::XCScheme::ArchiveAction.new
scheme.archive_action.build_configuration = "Release"
scheme.save_as(project_path, "contextos-desktop", true)

project.save
puts "Generated #{project_path}"
