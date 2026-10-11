; Inno Setup script - builds release\PDF-Editor-Setup.exe from dist\PDF Editor
#define AppName "PDF Editor"
#define AppVersion "1.0.0"
#define AppExe "PDF Editor.exe"

[Setup]
AppId={{6B0E5D0C-2B8E-4B41-9A53-7C1E0B6D4F21}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=PDF Editor
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; installs for the current user by default, so no administrator rights are needed
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=release
OutputBaseFilename=PDF-Editor-Setup
SetupIconFile=build\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "dist\PDF Editor\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
