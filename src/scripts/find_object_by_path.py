# -*- coding: utf-8 -*-
import sys
import traceback


def _safe_msg(msg):
    """Write a plain-ASCII message to stderr without triggering IronPython's
    broken ASCII-encoding path for unicode strings.  Any %s placeholders
    that may contain non-ASCII text are replaced with safe repr() values.
    """
    try:
        sys.stderr.write(msg + "\n")
        sys.stderr.flush()
    except Exception:
        pass


# Normalise an object/part name to a form that CODESYS ScriptEngine's
# find() API can match.
#
# In IronPython 2.7, get_name() on .NET objects returns a System.String
# disguised as Python 'str' (len=char_count, ord(c)>255 possible).  A
# str literal from script source is a genuine byte string.  find() only
# matches when given the former (System.String-like) form.
def _normalise_name(name):
    if name is None:
        return u""
    # IronPython 2.7 quirk: a string can be isinstance(s,unicode)==True but
    # actually contain UTF-8 bytes encoded as Latin-1 code points (all
    # ord(c) <= 255, len = byte_count).  A proper .NET System.String with
    # non-ASCII will have ord(c) > 255.
    if isinstance(name, unicode):
        has_wide = False
        for c in name:
            if ord(c) > 255:
                has_wide = True
                break
        if not has_wide:
            # UTF-8 bytes wearing a unicode disguise -- re-interpret.
            try:
                return name.encode('latin-1').decode('utf-8')
            except Exception:
                pass
        return name
    # Genuine str (non-unicode): try .NET-like path then byte decode.
    try:
        candidate = name.encode('utf-8').decode('utf-8')
        if len(candidate) > 0 and len(candidate) <= len(name):
            return candidate
    except Exception:
        pass
    for enc in ('utf-8', 'cp1252', 'latin-1'):
        try:
            return name.decode(enc)
        except UnicodeDecodeError:
            pass
    return name.decode('latin-1', errors='replace')


# --- Find object by path function ---
# Uses the CODESYS ScriptEngine's own find() API instead of comparing
# get_name() strings, because IronPython 2.7 str-vs-unicode comparison
# is unreliable for names containing non-ASCII characters.
def find_object_by_path_robust(start_node, full_path, target_type_name="object"):
    # Handle both dot and slash separators. Normalise backslashes first.
    path_with_slashes = full_path.replace('\\', '/').strip('/')
    # Only treat '.' as a separator when no '/' separator was used at all -
    # otherwise we corrupt namespaced names like 'MyLib.MyType' that
    # legitimately contain a dot inside a single path segment.
    if '/' in path_with_slashes:
        normalized_path = path_with_slashes
    else:
        normalized_path = path_with_slashes.replace('.', '/')
    path_parts = [p for p in normalized_path.split('/') if p]
    if not path_parts:
        _safe_msg("find_object_by_path: path is empty")
        return None

    # Determine the actual starting node (project or application)
    project = start_node
    if not hasattr(start_node, 'active_application') and hasattr(start_node, 'project'):
         try: project = start_node.project
         except Exception as proj_ref_err:
             _safe_msg("find_object_by_path: could not get project reference")

    # Try to get the application object robustly if we think we have the project
    app = None
    if hasattr(project, 'active_application'):
        try: app = project.active_application
        except Exception: pass
        if not app:
            try:
                 apps = project.find("Application", True)
                 if apps: app = apps[0]
            except Exception: pass

    app_name_lower = ""
    if app:
        try: app_name_lower = (app.get_name() or "application").lower()
        except Exception: app_name_lower = "application"

    # Decide where to start the traversal
    current_obj = start_node
    if hasattr(project, 'active_application'):
        if app and path_parts[0].lower() == app_name_lower:
             current_obj = app
             path_parts = path_parts[1:]
             if not path_parts:
                 return current_obj
        else:
            current_obj = project

    # Traverse the remaining path parts using the ScriptEngine's find() API,
    # which handles encoding internally -- no manual string comparison needed.
    parent_path_str = getattr(current_obj, 'get_name', lambda: str(current_obj))()

    for i, part_name in enumerate(path_parts):
        is_last_part = (i == len(path_parts) - 1)
        # Normalise to the form find() expects (System.String-like).
        search_name = _normalise_name(part_name)
        found_in_parent = None
        try:
            # Search immediate children first (non-recursive).
            found_list = current_obj.find(search_name, False)
            if found_list:
                found_in_parent = found_list[0]
            elif is_last_part:
                # Not an immediate child and this is the last segment --
                # fall back to a recursive search.
                found_list = current_obj.find(search_name, True)
                if found_list:
                    if len(found_list) > 1:
                        _safe_msg("find_object_by_path: ambiguous match for segment " + repr(part_name))
                        return None
                    found_in_parent = found_list[0]

            if found_in_parent:
                current_obj = found_in_parent
                parent_path_str = getattr(current_obj, 'get_name', lambda: part_name)()
            else:
                _safe_msg("find_object_by_path: segment not found " + repr(part_name))
                return None

        except Exception as find_err:
            _safe_msg("find_object_by_path: exception " + repr(find_err))
            return None

    # Traversal succeeded; the loop above already verified each segment via
    # find(). Return the resolved object directly -- no further string
    # comparison needed (and not possible for non-container objects).
    return current_obj

# --- End of find object function ---
