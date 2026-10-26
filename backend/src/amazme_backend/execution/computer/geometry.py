"""Map an upright screenshot point into the driver's raw pixels."""

from amazme_backend.shared.errors import BackendError


def upright_size(raw_width: int, raw_height: int, orientation: int) -> tuple[int, int]:
    if orientation in {6, 8}:
        return raw_height, raw_width
    if orientation in {1, 2, 3, 4}:
        return raw_width, raw_height
    raise BackendError("computer_orientation")


def raw_point(x: int, y: int, raw_width: int, raw_height: int, orientation: int) -> tuple[int, int]:
    """Invert EXIF orientation. Orientation 6 is the 90-degree display rotation."""
    if orientation == 1:
        return x, y
    if orientation == 2:
        return raw_width - 1 - x, y
    if orientation == 3:
        return raw_width - 1 - x, raw_height - 1 - y
    if orientation == 4:
        return x, raw_height - 1 - y
    if orientation == 6:
        return y, raw_height - 1 - x
    if orientation == 8:
        return raw_width - 1 - y, x
    raise BackendError("computer_orientation")


def driver_point(x: int, y: int, raw_width: int, raw_height: int, orientation: int, scale: int) -> tuple[int, int]:
    if scale < 1:
        raise BackendError("computer_scale")
    width, height = upright_size(raw_width, raw_height, orientation)
    if x < 0 or y < 0 or x >= width or y >= height:
        raise BackendError("computer_coordinate")
    raw_x, raw_y = raw_point(x, y, raw_width, raw_height, orientation)
    return raw_x * scale, raw_y * scale
