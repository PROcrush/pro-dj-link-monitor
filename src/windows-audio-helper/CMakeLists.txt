cmake_minimum_required(VERSION 3.20)
cmake_policy(SET CMP0091 NEW)
project(prodjlink_wasapi_ltc LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "prodjlink-wasapi-ltc is a Windows-only target")
endif()

string(TOLOWER "${CMAKE_GENERATOR_PLATFORM}" PRODJLINK_GENERATOR_ARCH)
string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" PRODJLINK_SYSTEM_ARCH)

if(PRODJLINK_GENERATOR_ARCH)
  if(PRODJLINK_GENERATOR_ARCH STREQUAL "arm64")
    set(PRODJLINK_ARCH "arm64")
  elseif(PRODJLINK_GENERATOR_ARCH STREQUAL "x64")
    set(PRODJLINK_ARCH "x64")
  else()
    message(FATAL_ERROR "Only x64 and ARM64 builds are supported")
  endif()
elseif(PRODJLINK_SYSTEM_ARCH MATCHES "^(arm64|aarch64)$")
  set(PRODJLINK_ARCH "arm64")
elseif(PRODJLINK_SYSTEM_ARCH MATCHES "^(amd64|x86_64)$")
  set(PRODJLINK_ARCH "x64")
else()
  message(FATAL_ERROR "Only x64 and ARM64 builds are supported")
endif()

set(PRODJLINK_BIN_DIR "${CMAKE_CURRENT_SOURCE_DIR}/bin/${PRODJLINK_ARCH}")

if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

add_executable(prodjlink-wasapi-ltc src/main.cpp)
set_property(
  TARGET prodjlink-wasapi-ltc
  PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
target_compile_features(prodjlink-wasapi-ltc PRIVATE cxx_std_17)
target_compile_definitions(
  prodjlink-wasapi-ltc
  PRIVATE UNICODE _UNICODE _WIN32_WINNT=0x0601
)
target_link_libraries(prodjlink-wasapi-ltc PRIVATE ole32 uuid propsys)

if(MSVC)
  target_compile_options(
    prodjlink-wasapi-ltc
    PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus
  )
endif()

set_target_properties(
  prodjlink-wasapi-ltc
  PROPERTIES
    OUTPUT_NAME "prodjlink-wasapi-ltc"
    RUNTIME_OUTPUT_DIRECTORY "${PRODJLINK_BIN_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${PRODJLINK_BIN_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${PRODJLINK_BIN_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${PRODJLINK_BIN_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${PRODJLINK_BIN_DIR}"
)

add_executable(ltc-generator-test tests/ltc_generator_test.cpp)
target_compile_features(ltc-generator-test PRIVATE cxx_std_17)
set_target_properties(
  ltc-generator-test
  PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/tests"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_BINARY_DIR}/tests"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/tests"
)

enable_testing()
add_test(NAME ltc-generator-test COMMAND ltc-generator-test)
