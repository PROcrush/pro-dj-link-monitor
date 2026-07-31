@echo off
setlocal

set "ARCH=%~1"
if "%ARCH%"=="" set "ARCH=x64"

if /I "%ARCH%"=="x64" (
  set "CMAKE_ARCH=x64"
) else if /I "%ARCH%"=="arm64" (
  set "CMAKE_ARCH=ARM64"
) else (
  echo Usage: build.cmd [x64^|arm64]
  exit /b 2
)

where cmake >nul 2>nul
if errorlevel 1 (
  echo CMake was not found. Install Visual Studio Build Tools with C++ and CMake support.
  exit /b 1
)

cmake -S "%~dp0" -B "%~dp0build\%ARCH%" -A %CMAKE_ARCH%
if errorlevel 1 exit /b 1

cmake --build "%~dp0build\%ARCH%" --config Release
if errorlevel 1 exit /b 1

echo Built: %~dp0bin\%ARCH%\prodjlink-wasapi-ltc.exe
