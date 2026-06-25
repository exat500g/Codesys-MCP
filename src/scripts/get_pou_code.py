import sys, scriptengine as script_engine, os, traceback

POU_FULL_PATH = "{POU_FULL_PATH}"
CODE_START_MARKER = "### POU CODE START ###"
CODE_END_MARKER = "### POU CODE END ###"
DECL_START_MARKER = "### POU DECLARATION START ###"
DECL_END_MARKER = "### POU DECLARATION END ###"
IMPL_START_MARKER = "### POU IMPLEMENTATION START ###"
IMPL_END_MARKER = "### POU IMPLEMENTATION END ###"

def _emit_text(s):
    """Write a possibly-non-ASCII string to stdout as utf-8 bytes.

    Avoids `print` of unicode under IronPython subprocess stdout where the
    codec is undefined. Falls back through _to_unicode if the input is bytes.
    """
    if s is None:
        return
    if isinstance(s, unicode):
        sys.stdout.write(s.encode('utf-8'))
    else:
        try:
            sys.stdout.write(_to_unicode(s).encode('utf-8'))
        except Exception:
            sys.stdout.write(str(s))

try:
    _safe_print("Getting code:", POU_FULL_PATH)
    # Resource read - refuse to silently switch projects.
    primary_project = require_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("not found: " + POU_FULL_PATH.encode('utf-8'))

    target_name = getattr(target_object, 'get_name', lambda: POU_FULL_PATH)()
    _safe_print("Found target:", target_name)

    declaration_code = u""; implementation_code = u""

    # --- Get Declaration Part ---
    if hasattr(target_object, 'textual_declaration'):
        decl_obj = target_object.textual_declaration
        if decl_obj and hasattr(decl_obj, 'text'):
            try:
                declaration_code = _to_unicode(decl_obj.text) if decl_obj.text else u""
            except Exception as decl_read_err:
                _safe_print("ERROR reading declaration:", repr(decl_read_err))
                declaration_code = u"/* ERROR reading declaration */" 
        else:
            pass
    else:
        pass

    # --- Get Implementation Part ---
    if hasattr(target_object, 'textual_implementation'):
        impl_obj = target_object.textual_implementation
        if impl_obj and hasattr(impl_obj, 'text'):
            try:
                implementation_code = _to_unicode(impl_obj.text) if impl_obj.text else u""
            except Exception as impl_read_err:
                _safe_print("ERROR reading implementation:", repr(impl_read_err))
                implementation_code = u"/* ERROR reading implementation */"
        else:
            pass
    else:
        pass


    sys.stdout.write("\n" + DECL_START_MARKER + "\n")
    _emit_text(declaration_code)
    sys.stdout.write("\n" + DECL_END_MARKER + "\n\n")
    sys.stdout.write(IMPL_START_MARKER + "\n")
    _emit_text(implementation_code)
    sys.stdout.write("\n" + IMPL_END_MARKER + "\n\n")
    sys.stdout.flush()

    sys.stdout.write("SCRIPT_SUCCESS\n")
    sys.exit(0)
except Exception as e:
    _safe_print("get_pou_code error:", repr(e))
    _safe_print("SCRIPT_ERROR: see traceback")
    sys.exit(1)
